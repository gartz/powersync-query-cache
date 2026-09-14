import { QueryCacheEntry, QueryCacheInvalidation, QueryCacheMeta, QueryCacheStorage, QueryCacheTouch } from '../types.js';
import { createInvalidationChannel, InvalidationChannel, registerFlushTriggers } from './broadcast.js';
import { META_STORE, openCacheDatabase, PAYLOAD_STORE, requestToPromise, transactionToPromise } from './database.js';

export interface IndexedDbQueryCacheStorageOptions {
  /** IndexedDB database name. Defaults to `powersync-query-cache`. */
  databaseName?: string;
  /** BroadcastChannel name. Defaults to `powersync-query-cache`. */
  channelName?: string;
}

interface PayloadRecord {
  key: string;
  /** The sealed envelope. Carries the query signature with the rows; see QueryCacheEntry. */
  payload: Uint8Array;
  iv?: Uint8Array;
}

const DEFAULT_NAME = 'powersync-query-cache';

/**
 * IndexedDB-backed {@link QueryCacheStorage}.
 *
 * Metadata and payloads live in separate object stores so eviction, pruning and TTL
 * sweeps read only small records and never touch (or decrypt) row data.
 */
export class IndexedDbQueryCacheStorage implements QueryCacheStorage {
  private readonly databaseName: string;
  private readonly channelName: string;
  private database?: IDBDatabase;
  private channel?: InvalidationChannel;

  constructor(options?: IndexedDbQueryCacheStorageOptions) {
    this.databaseName = options?.databaseName ?? DEFAULT_NAME;
    this.channelName = options?.channelName ?? DEFAULT_NAME;
  }

  async open(): Promise<void> {
    this.database ??= await openCacheDatabase(this.databaseName);
    this.channel ??= createInvalidationChannel(this.channelName);
  }

  async read(key: string): Promise<QueryCacheEntry | undefined> {
    const db = this.require();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readonly');
    // Both requests are issued synchronously, before anything is awaited. Awaiting the
    // first and only then issuing the second risks the transaction having auto-committed
    // in between (TransactionInactiveError), since a transaction stays alive only while
    // it has outstanding requests.
    const metaRequest = tx.objectStore(META_STORE).get(key);
    const payloadRequest = tx.objectStore(PAYLOAD_STORE).get(key);

    const [meta, payload] = await Promise.all([
      requestToPromise<QueryCacheMeta | undefined>(metaRequest),
      requestToPromise<PayloadRecord | undefined>(payloadRequest)
    ]);

    if (!meta || !payload) {
      return undefined;
    }

    return {
      ...meta,
      payload: payload.payload,
      iv: payload.iv
    };
  }

  async write(entry: QueryCacheEntry): Promise<void> {
    const db = this.require();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');

    tx.objectStore(META_STORE).put({
      key: entry.key,
      namespace: entry.namespace,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt,
      bytes: entry.bytes
    } satisfies QueryCacheMeta);

    tx.objectStore(PAYLOAD_STORE).put({
      key: entry.key,
      payload: entry.payload,
      iv: entry.iv
    } satisfies PayloadRecord);

    await transactionToPromise(tx);
  }

  async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const db = this.require();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    for (const key of keys) {
      tx.objectStore(META_STORE).delete(key);
      tx.objectStore(PAYLOAD_STORE).delete(key);
    }
    await transactionToPromise(tx);
  }

  async listMeta(): Promise<QueryCacheMeta[]> {
    const db = this.require();
    const tx = db.transaction(META_STORE, 'readonly');
    return requestToPromise<QueryCacheMeta[]>(tx.objectStore(META_STORE).getAll());
  }

  async touch(touches: QueryCacheTouch[]): Promise<void> {
    if (touches.length === 0) {
      return;
    }
    const db = this.require();
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);

    for (const { key, lastUsedAt } of touches) {
      const existing = await requestToPromise<QueryCacheMeta | undefined>(store.get(key));
      if (existing) {
        store.put({ ...existing, lastUsedAt });
      }
    }

    await transactionToPromise(tx);
  }

  async clear(): Promise<void> {
    const db = this.require();
    const tx = db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    tx.objectStore(META_STORE).clear();
    tx.objectStore(PAYLOAD_STORE).clear();
    await transactionToPromise(tx);
  }

  onInvalidate(handler: (event: QueryCacheInvalidation) => void): () => void {
    return this.channel?.subscribe(handler) ?? (() => {});
  }

  notifyInvalidated(event: QueryCacheInvalidation): void {
    this.channel?.publish(event);
  }

  registerFlush(flush: () => void): () => void {
    return registerFlushTriggers(flush);
  }

  async dispose(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    this.channel?.close();
    this.channel = undefined;
  }

  private require(): IDBDatabase {
    if (!this.database) {
      throw new Error('Query cache storage used before open()');
    }
    return this.database;
  }
}
