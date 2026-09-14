import {
  QueryCacheEntry,
  QueryCacheInvalidation,
  QueryCacheMeta,
  QueryCacheStorage,
  QueryCacheTouch
} from '../src/types.js';

/**
 * In-memory QueryCacheStorage for tests. Records every call so the manager's IO
 * behaviour (debounce collapsing, sweep throttling, touch coalescing) is assertable
 * without IndexedDB.
 */
export class FakeQueryCacheStorage implements QueryCacheStorage {
  readonly entries = new Map<string, QueryCacheEntry>();
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  readonly deletes: string[][] = [];
  readonly touches: QueryCacheTouch[][] = [];
  listMetaCalls = 0;
  clearCalls = 0;
  published: QueryCacheInvalidation[] = [];

  /** Set to reject every operation, simulating a broken store. */
  failEverything = false;
  /** Set to make open() hang, simulating a blocked IndexedDB upgrade. */
  hangOnOpen = false;
  /** Set to hold clear() open until the promise resolves, simulating a slow wipe. */
  blockClear?: Promise<void>;

  private invalidateHandlers = new Set<(event: QueryCacheInvalidation) => void>();

  async open(): Promise<void> {
    if (this.hangOnOpen) {
      return new Promise<void>(() => {});
    }
    this.assertHealthy();
  }

  async read(key: string): Promise<QueryCacheEntry | undefined> {
    this.assertHealthy();
    this.reads.push(key);
    return this.entries.get(key);
  }

  async write(entry: QueryCacheEntry): Promise<void> {
    this.assertHealthy();
    this.writes.push(entry.key);
    this.entries.set(entry.key, entry);
  }

  async deleteKeys(keys: string[]): Promise<void> {
    this.assertHealthy();
    this.deletes.push(keys);
    for (const key of keys) {
      this.entries.delete(key);
    }
  }

  async listMeta(): Promise<QueryCacheMeta[]> {
    this.assertHealthy();
    this.listMetaCalls++;
    return [...this.entries.values()].map(({ key, namespace, updatedAt, lastUsedAt, bytes }) => ({
      key,
      namespace,
      updatedAt,
      lastUsedAt,
      bytes
    }));
  }

  async touch(touches: QueryCacheTouch[]): Promise<void> {
    this.assertHealthy();
    this.touches.push(touches);
    for (const { key, lastUsedAt } of touches) {
      const entry = this.entries.get(key);
      if (entry) {
        entry.lastUsedAt = lastUsedAt;
      }
    }
  }

  async clear(): Promise<void> {
    this.assertHealthy();
    if (this.blockClear) {
      await this.blockClear;
    }
    this.clearCalls++;
    this.entries.clear();
  }

  onInvalidate(handler: (event: QueryCacheInvalidation) => void): () => void {
    this.invalidateHandlers.add(handler);
    return () => this.invalidateHandlers.delete(handler);
  }

  notifyInvalidated(event: QueryCacheInvalidation): void {
    this.published.push(event);
  }

  /** Simulate another tab publishing an invalidation. */
  receiveInvalidation(event: QueryCacheInvalidation): void {
    for (const handler of this.invalidateHandlers) {
      handler(event);
    }
  }

  private assertHealthy() {
    if (this.failEverything) {
      throw new Error('storage unavailable');
    }
  }
}
