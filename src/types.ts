/**
 * Metadata for one cached query result. Stored apart from the payload so eviction,
 * TTL sweeps and pruning never read (or decrypt) row data.
 *
 * @alpha
 */
export interface QueryCacheMeta {
  /** Hashed, namespaced key. See `persistedKeyFor` in @powersync/shared-internals. */
  key: string;
  /** Identity bucket: database name, schema, encryption key and cache version. */
  namespace: string;
  /** When the rows were written. Drives TTL. */
  updatedAt: number;
  /** When the entry was last read or written. Drives LRU eviction. */
  lastUsedAt: number;
  /** Encoded payload length in bytes. Drives the storage budget. */
  bytes: number;
}

/**
 * A cached query result.
 *
 * @alpha
 */
export interface QueryCacheEntry extends QueryCacheMeta {
  /**
   * The encoded entry; ciphertext when encryption is active.
   *
   * Carries the query signature it was written for alongside the rows, so a read can
   * discard an entry whose signature does not match the requesting query and a
   * key-hash collision can never serve one query another's rows. The signature is
   * sealed with the rows rather than stored beside them: on disk it is raw SQL and
   * raw parameter values, and the persisted key is hashed precisely so that neither
   * is readable there.
   */
  payload: Uint8Array;
  /** AES-GCM initialisation vector. Present only when the payload is encrypted. */
  iv?: Uint8Array;
}

/**
 * A batched LRU touch.
 *
 * @alpha
 */
export interface QueryCacheTouch {
  key: string;
  lastUsedAt: number;
}

/**
 * Cross-context invalidation message.
 *
 * @alpha
 */
export type QueryCacheInvalidation = { type: 'all' } | { type: 'namespace'; namespace: string };

/**
 * Persistent backing store for the query cache.
 *
 * Implementations are platform-specific; `@powersync/query-cache-idb` provides one for
 * browsers. Every method may reject — the cache treats any failure as "no persistent
 * layer for this session" and never propagates it into a query.
 *
 * @alpha
 */
export interface QueryCacheStorage {
  /** Resolve when the store is usable. The caller applies its own timeout. */
  open(): Promise<void>;

  read(key: string): Promise<QueryCacheEntry | undefined>;
  write(entry: QueryCacheEntry): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;

  /** Metadata for every stored entry. Must not read payloads. */
  listMeta(): Promise<QueryCacheMeta[]>;

  /** Apply batched LRU touches. */
  touch(touches: QueryCacheTouch[]): Promise<void>;

  clear(): Promise<void>;

  /** Subscribe to invalidations published by other contexts. Returns a disposer. */
  onInvalidate?(handler: (event: QueryCacheInvalidation) => void): () => void;

  /** Publish an invalidation to other contexts. */
  notifyInvalidated?(event: QueryCacheInvalidation): void;

  /**
   * Register a platform flush trigger (e.g. `pagehide`). The handler must be safe to
   * call repeatedly. Returns a disposer.
   */
  registerFlush?(flush: () => void): () => void;

  dispose?(): Promise<void>;
}

/**
 * Per-layer byte budget. Entries are evicted least-recently-used first once the
 * budget is exceeded, regardless of TTL.
 *
 * @alpha
 */
export interface QueryCacheLayerOptions {
  maxBytes?: number;
}

/**
 * Encryption controls for the persistent layer. The memory layer is never encrypted.
 *
 * @alpha
 */
export interface QueryCacheEncryptionOptions {
  /**
   * Supply the AES-GCM key directly instead of deriving it from the database's
   * encryption key. Use this when the encryption key is derived from a user
   * passphrase — the default HKDF derivation does not stretch it.
   */
  getKey?: () => Promise<CryptoKey>;
}

/**
 * Global query cache configuration, passed when constructing a PowerSync database.
 *
 * Omitting this option disables caching entirely.
 *
 * @alpha
 */
export interface QueryCacheOptions {
  /** Persistent backing store. Without one, only the in-memory layer is available. */
  storage?: QueryCacheStorage;
  /** Defaults to `true` when `storage` is set, `false` otherwise. */
  enabled?: boolean;
  /** Default entry lifetime in milliseconds. Defaults to 7 days. */
  ttlMs?: number;
  /** Bump to invalidate every entry, e.g. when result shapes change in a release. */
  version?: string | number;
  memory?: QueryCacheLayerOptions;
  persisted?: QueryCacheLayerOptions;
  /** Results encoding larger than this are never stored. Defaults to 1 MiB. */
  maxEntryBytes?: number;
  /** Trailing debounce before a write reaches storage. Defaults to 1500 ms. */
  debounceMs?: number;
  /**
   * Encryption key for cached payloads. Defaults to the key the database was opened
   * with, when the platform exposes one.
   */
  encryptionKey?: string;
  encryption?: QueryCacheEncryptionOptions;
}

/**
 * Per-query cache override. `true` opts in when the global cache is disabled,
 * `false` opts out when it is enabled, and an object overrides the TTL.
 *
 * @alpha
 */
export type QueryCacheQueryOption = boolean | { enabled?: boolean; ttlMs?: number };
