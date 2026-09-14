/**
 * IndexedDB plumbing for the query cache.
 *
 * This package owns its own database and version number. It deliberately does not share
 * the PowerSync SQLite VFS database: a version bump there that another tab blocks would
 * hang PowerSync's own boot.
 *
 * @internal
 */

export const DATABASE_VERSION = 1;
export const META_STORE = 'query_cache_meta';
export const PAYLOAD_STORE = 'query_cache_payloads';

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openCacheDatabase(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const meta = db.createObjectStore(META_STORE, { keyPath: 'key' });
        // Eviction sorts by lastUsedAt; pruning filters by namespace. Both are index
        // scans over small records, never a full payload read.
        meta.createIndex('lastUsedAt', 'lastUsedAt');
        meta.createIndex('namespace', 'namespace');
      }
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
        db.createObjectStore(PAYLOAD_STORE, { keyPath: 'key' });
      }
    };

    request.onblocked = () => {
      reject(new Error('Query cache database upgrade is blocked by another tab'));
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another context wants to upgrade: close so it can proceed. Without this the
      // other context hangs indefinitely with no error.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('Could not open query cache database'));
  });
}
