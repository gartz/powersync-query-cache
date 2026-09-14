import { afterEach, describe, expect, it } from 'vitest';
import { META_STORE, openCacheDatabase, PAYLOAD_STORE } from '../../src/idb/database.js';

const databases: IDBDatabase[] = [];
const uniqueName = () => `powersync-query-cache-test-${crypto.randomUUID()}`;

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describe('openCacheDatabase', () => {
  it('creates both stores', async () => {
    const db = await openCacheDatabase(uniqueName());
    databases.push(db);

    expect([...db.objectStoreNames].sort()).toEqual([META_STORE, PAYLOAD_STORE].sort());
  });

  it('indexes metadata by lastUsedAt and namespace', async () => {
    const db = await openCacheDatabase(uniqueName());
    databases.push(db);

    const store = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    expect([...store.indexNames].sort()).toEqual(['lastUsedAt', 'namespace']);
  });

  it('closes itself when another context needs to upgrade', async () => {
    const name = uniqueName();
    const db = await openCacheDatabase(name);
    databases.push(db);

    // Simulate a future version arriving from another tab.
    const upgrade = indexedDB.open(name, 99);
    await new Promise<void>((resolve, reject) => {
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
      upgrade.onerror = () => reject(upgrade.error);
      upgrade.onblocked = () => reject(new Error('upgrade was blocked — the blocking handler did not close us'));
    });

    // The upgrade request only succeeds once every other connection has closed, so
    // reaching here already proves `onversionchange` closed `db`. Confirm it directly:
    // a closed connection throws synchronously when a transaction is started on it.
    // (Per the IndexedDB spec, the `close` event fires only on a *forced* close — never
    // after a voluntary `IDBDatabase.close()` call — so asserting on that event here
    // would never pass in a spec-compliant browser.)
    expect(() => db.transaction(META_STORE, 'readonly')).toThrow();
  });
});
