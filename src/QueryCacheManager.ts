import { LogLevels, PowerSyncLogger } from '@powersync/common';
import { QueryCacheInvalidation, QueryCacheOptions, QueryCacheQueryOption, QueryCacheStorage } from './types.js';
import { decodeEnvelope, encodeEnvelope, QueryCacheEncodeError } from './codec.js';
import { createAesGcmCrypto, createPlaintextCrypto, deriveCacheKey, QueryCacheCrypto } from './crypto.js';
import { persistedKeyFor } from './keys.js';
import { MemoryQueryCache } from './MemoryQueryCache.js';
import {
  estimateRowsBytes,
  isExpired,
  ResolvedQueryCacheConfig,
  resolveCacheForQuery,
  resolveQueryCacheConfig,
  selectEvictions,
  shouldPersistEmission
} from './policy.js';
import { DebouncedWriteScheduler, TouchBuffer } from './scheduler.js';

/**
 * Orchestrates the two cache layers.
 *
 * Every method is best-effort: a storage failure disables the persistent layer for the
 * session and is logged once, but never reaches the caller. The memory layer keeps
 * working regardless.
 *
 * @internal
 */

export interface QueryCacheHit {
  rows: readonly unknown[];
  cachedAt: Date;
}

export interface QueryCacheManagerOptions {
  options: QueryCacheOptions | undefined;
  namespace: Promise<string>;
  logger: PowerSyncLogger;
  /** Injectable for tests. Defaults to `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
  /** Injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Run a budget sweep every N persisted writes. Defaults to 10. */
  sweepEveryWrites?: number;
}

const DEFAULT_SWEEP_EVERY_WRITES = 10;

export function createQueryCacheManager(options: QueryCacheManagerOptions): QueryCacheManager {
  return new QueryCacheManager(options);
}

export class QueryCacheManager {
  readonly enabled: boolean;

  private readonly config: ResolvedQueryCacheConfig;
  private readonly memory: MemoryQueryCache;
  private readonly scheduler: DebouncedWriteScheduler;
  private readonly touches = new TouchBuffer();
  private readonly logger: PowerSyncLogger;
  private readonly subtle: SubtleCrypto;
  private readonly clock: () => number;
  private readonly sweepEveryWrites: number;
  private readonly unencodable = new Set<string>();
  /** Persist chains started but not yet settled — awaited by flush(). */
  private readonly inFlight = new Set<Promise<void>>();

  private readonly namespace: Promise<string>;
  private storagePromise?: Promise<QueryCacheStorage | undefined>;
  private crypto?: QueryCacheCrypto;
  private disposeInvalidation?: () => void;
  private disposeFlushHook?: () => void;
  private touchTimer?: ReturnType<typeof setTimeout>;
  private writesSinceSweep = 0;
  private persistentDisabled = false;

  constructor(managerOptions: QueryCacheManagerOptions) {
    this.config = resolveQueryCacheConfig(managerOptions.options);
    this.enabled = this.config.enabled;
    this.namespace = managerOptions.namespace;
    this.logger = managerOptions.logger;
    this.subtle = managerOptions.subtle ?? globalThis.crypto.subtle;
    this.clock = managerOptions.clock ?? (() => Date.now());
    this.sweepEveryWrites = managerOptions.sweepEveryWrites ?? DEFAULT_SWEEP_EVERY_WRITES;
    this.memory = new MemoryQueryCache(this.config.memoryMaxBytes);
    this.scheduler = new DebouncedWriteScheduler(this.config.debounceMs);
  }

  /**
   * Resolves the effective cache setting for one query. Lives here — not in the
   * processor — so the resolved global config has exactly one home.
   */
  resolveForQuery(perQuery: QueryCacheQueryOption | undefined): { enabled: boolean; ttlMs: number } {
    return resolveCacheForQuery(this.config, perQuery);
  }

  /** Synchronous memory lookup. Safe to call before the database is ready. */
  peek(signature: string, ttlMs: number): QueryCacheHit | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const now = this.clock();
    const entry = this.memory.get(signature, now);
    if (!entry) {
      return undefined;
    }
    if (isExpired(entry.updatedAt, ttlMs, now)) {
      this.memory.delete(signature);
      return undefined;
    }
    return { rows: entry.rows, cachedAt: new Date(entry.updatedAt) };
  }

  /** Asynchronous persisted lookup. Never awaits the database. */
  async hydrate(signature: string, ttlMs: number, signal?: AbortSignal): Promise<QueryCacheHit | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    try {
      const storage = await this.storage();
      if (!storage || signal?.aborted) {
        return undefined;
      }

      const namespace = await this.namespace;
      const key = await persistedKeyFor(namespace, signature, this.subtle);
      const entry = await storage.read(key);
      if (!entry || signal?.aborted) {
        return undefined;
      }

      const now = this.clock();
      if (isExpired(entry.updatedAt, ttlMs, now)) {
        void this.safely(() => storage.deleteKeys([key]));
        return undefined;
      }

      const plain = await (await this.resolveCrypto()).open(entry.payload, entry.iv);
      const envelope = decodeEnvelope(plain);
      if (!envelope || envelope.signature !== signature) {
        // Key-hash collision, or a record written by an older payload format. Either
        // way this entry is not this query's, so it is deleted rather than served.
        void this.safely(() => storage.deleteKeys([key]));
        return undefined;
      }
      const rows = envelope.rows;

      this.memory.set(signature, {
        rows,
        updatedAt: entry.updatedAt,
        lastUsedAt: now,
        bytes: entry.bytes
      });
      this.recordTouch(key, now);

      return { rows, cachedAt: new Date(entry.updatedAt) };
    } catch (error) {
      this.disablePersistent(error);
      return undefined;
    }
  }

  /** Records a live emission in memory and schedules the persisted write. */
  record(signature: string, rows: readonly unknown[], context: { hasSynced: boolean | undefined }): void {
    if (!this.enabled) {
      return;
    }
    if (!shouldPersistEmission({ rowCount: rows.length, hasSynced: context.hasSynced })) {
      return;
    }

    const now = this.clock();
    const bytes = estimateRowsBytes(rows);
    this.memory.set(signature, { rows, updatedAt: now, lastUsedAt: now, bytes });

    if (bytes > this.config.maxEntryBytes || this.unencodable.has(signature)) {
      return;
    }

    // The rows and timestamp are captured here, at schedule time. Nothing about the
    // write may be re-read when the timer fires — identity can change in between.
    this.scheduler.schedule(signature, () => {
      const persist = this.persist(signature, rows, now);
      this.inFlight.add(persist);
      void persist.finally(() => this.inFlight.delete(persist));
    });
  }

  /**
   * Runs pending writes and touches now, and resolves only when they have settled.
   *
   * A bare `Promise.resolve()` here is NOT enough: `persist()` awaits real async work
   * (SHA-256 key hashing, the storage write), so callers that flush-then-read — every
   * test, and `close()` — would race a half-finished write. The in-flight set is the
   * only reliable completion signal.
   */
  async flush(): Promise<void> {
    this.scheduler.flush();
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
    await this.flushTouches();
  }

  async clear(): Promise<void> {
    this.memory.clear();
    this.scheduler.cancelAll();

    const wipe = (async () => {
      const storage = await this.storage();
      if (!storage) {
        return;
      }
      await this.safely(async () => {
        await storage.clear();
        storage.notifyInvalidated?.({ type: 'all' });
      });
    })();

    // Tracked like a persist: `disconnectAndClear()` fires the `cleared` listener
    // without awaiting it, so without this a following flush()/close() — and the
    // database close behind it — could resolve while the physical delete is still
    // running, leaving the wiped rows on disk.
    this.inFlight.add(wipe);
    try {
      await wipe;
    } finally {
      this.inFlight.delete(wipe);
    }
  }

  /** Deletes entries belonging to any other identity bucket. */
  async pruneForeign(): Promise<void> {
    const storage = await this.storage();
    if (!storage) {
      return;
    }
    await this.safely(async () => {
      const namespace = await this.namespace;
      const meta = await storage.listMeta();
      const foreign = meta.filter((entry) => entry.namespace !== namespace).map((entry) => entry.key);
      if (foreign.length) {
        await storage.deleteKeys(foreign);
      }
    });
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = undefined;
    }
    this.disposeInvalidation?.();
    this.disposeFlushHook?.();
    this.memory.clear();
    const storage = await this.storage();
    await this.safely(() => storage?.dispose?.() ?? Promise.resolve());
  }

  private async persist(signature: string, rows: readonly unknown[], updatedAt: number): Promise<void> {
    const storage = await this.storage();
    if (!storage) {
      return;
    }

    let payload: Uint8Array;
    try {
      payload = encodeEnvelope(signature, rows);
    } catch (error) {
      // Not a storage failure: this one query's results cannot be represented.
      this.unencodable.add(signature);
      this.logger.log({
        level: LogLevels.warn,
        message: 'Query result cannot be cached and will be skipped for this query.',
        error: error instanceof QueryCacheEncodeError ? error : new QueryCacheEncodeError(error)
      });
      return;
    }

    if (payload.byteLength > this.config.maxEntryBytes) {
      return;
    }

    await this.safely(async () => {
      const namespace = await this.namespace;
      const key = await persistedKeyFor(namespace, signature, this.subtle);
      const sealed = await (await this.resolveCrypto()).seal(payload);

      await storage.write({
        key,
        namespace,
        updatedAt,
        lastUsedAt: updatedAt,
        bytes: payload.byteLength,
        payload: sealed.payload,
        iv: sealed.iv
      });

      if (++this.writesSinceSweep >= this.sweepEveryWrites) {
        this.writesSinceSweep = 0;
        await this.sweepBudget(storage);
      }
    });
  }

  private async sweepBudget(storage: QueryCacheStorage): Promise<void> {
    const meta = await storage.listMeta();
    const victims = selectEvictions(meta, this.config.persistedMaxBytes);
    if (victims.length) {
      await storage.deleteKeys(victims);
    }
  }

  private recordTouch(key: string, now: number): void {
    this.touches.add(key, now);
    if (this.touchTimer) {
      return;
    }
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined;
      void this.flushTouches();
    }, this.config.touchFlushMs);
  }

  private async flushTouches(): Promise<void> {
    if (this.touches.size === 0) {
      return;
    }
    const pending = this.touches.drain();
    const storage = await this.storage();
    if (!storage) {
      return;
    }
    await this.safely(() => storage.touch(pending));
  }

  private storage(): Promise<QueryCacheStorage | undefined> {
    if (!this.enabled || this.persistentDisabled || !this.config.storage) {
      return Promise.resolve(undefined);
    }

    this.storagePromise ??= (async () => {
      const storage = this.config.storage!;
      try {
        await withTimeout(storage.open(), this.config.openTimeoutMs);
      } catch (error) {
        // A blocked IndexedDB upgrade never settles; this is the guard that stops it
        // from hanging anything.
        this.disablePersistent(error);
        return undefined;
      }

      this.disposeInvalidation = storage.onInvalidate?.((event: QueryCacheInvalidation) => {
        void this.handleInvalidation(event);
      });
      this.disposeFlushHook = storage.registerFlush?.(() => {
        this.scheduler.flush();
        void this.flushTouches();
      });

      return storage;
    })();

    return this.storagePromise;
  }

  private async handleInvalidation(event: QueryCacheInvalidation): Promise<void> {
    if (event.type === 'all') {
      this.memory.clear();
      return;
    }
    if (event.namespace === (await this.namespace)) {
      this.memory.clear();
    }
  }

  private async resolveCrypto(): Promise<QueryCacheCrypto> {
    if (this.crypto) {
      return this.crypto;
    }

    const getKey = this.config.getKey;
    if (getKey) {
      this.crypto = createAesGcmCrypto(this.subtle, getKey);
    } else if (this.config.encryptionKey) {
      const encryptionKey = this.config.encryptionKey;
      const namespace = await this.namespace;
      this.crypto = createAesGcmCrypto(this.subtle, () =>
        deriveCacheKey(this.subtle, encryptionKey, namespace)
      );
    } else {
      this.crypto = createPlaintextCrypto();
    }

    return this.crypto;
  }

  private async safely<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      this.disablePersistent(error);
      return undefined;
    }
  }

  private disablePersistent(error: unknown): void {
    if (this.persistentDisabled) {
      return;
    }
    this.persistentDisabled = true;
    this.scheduler.cancelAll();
    this.logger.log({
      level: LogLevels.warn,
      message: 'Persistent query cache disabled for this session after a storage failure.',
      error
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Query cache storage did not open in time')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
