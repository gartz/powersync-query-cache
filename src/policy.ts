import { QueryCacheOptions, QueryCacheQueryOption, QueryCacheStorage } from './types.js';

/**
 * Pure policy for the query cache: configuration resolution, TTL, size accounting,
 * eviction selection and the write gate. No IO, no platform APIs.
 *
 * @internal
 */

export const DEFAULT_QUERY_CACHE_CONFIG = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  memoryMaxBytes: 8 * 1024 * 1024,
  persistedMaxBytes: 50 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  debounceMs: 1500,
  touchFlushMs: 5000,
  openTimeoutMs: 3000
} as const;

export interface ResolvedQueryCacheConfig {
  enabled: boolean;
  storage?: QueryCacheStorage;
  ttlMs: number;
  version: string;
  memoryMaxBytes: number;
  persistedMaxBytes: number;
  maxEntryBytes: number;
  debounceMs: number;
  touchFlushMs: number;
  openTimeoutMs: number;
  encryptionKey?: string;
  getKey?: () => Promise<CryptoKey>;
}

export function resolveQueryCacheConfig(options: QueryCacheOptions | undefined): ResolvedQueryCacheConfig {
  return {
    enabled: options?.enabled ?? options?.storage != null,
    storage: options?.storage,
    ttlMs: options?.ttlMs ?? DEFAULT_QUERY_CACHE_CONFIG.ttlMs,
    version: String(options?.version ?? '1'),
    memoryMaxBytes: options?.memory?.maxBytes ?? DEFAULT_QUERY_CACHE_CONFIG.memoryMaxBytes,
    persistedMaxBytes: options?.persisted?.maxBytes ?? DEFAULT_QUERY_CACHE_CONFIG.persistedMaxBytes,
    maxEntryBytes: options?.maxEntryBytes ?? DEFAULT_QUERY_CACHE_CONFIG.maxEntryBytes,
    debounceMs: options?.debounceMs ?? DEFAULT_QUERY_CACHE_CONFIG.debounceMs,
    touchFlushMs: DEFAULT_QUERY_CACHE_CONFIG.touchFlushMs,
    openTimeoutMs: DEFAULT_QUERY_CACHE_CONFIG.openTimeoutMs,
    encryptionKey: options?.encryptionKey,
    getKey: options?.encryption?.getKey
  };
}

export interface ResolvedQueryCacheForQuery {
  enabled: boolean;
  ttlMs: number;
}

export function resolveCacheForQuery(
  config: ResolvedQueryCacheConfig,
  perQuery: QueryCacheQueryOption | undefined
): ResolvedQueryCacheForQuery {
  if (perQuery === undefined) {
    return { enabled: config.enabled, ttlMs: config.ttlMs };
  }
  if (typeof perQuery === 'boolean') {
    return { enabled: perQuery, ttlMs: config.ttlMs };
  }
  return {
    enabled: perQuery.enabled ?? true,
    ttlMs: perQuery.ttlMs ?? config.ttlMs
  };
}

const EMPTY_RESULT_BYTES = 32;
const PER_ENTRY_OVERHEAD_BYTES = 64;
const SAMPLE_SIZE = 3;

/**
 * Approximates the encoded size of a result set by sampling rows.
 *
 * This is a budget, not a ledger: SQL results are uniform enough that sampling lands
 * within a few percent, and measuring exactly would mean serializing every result
 * twice on the render path.
 */
export function estimateRowsBytes(rows: readonly unknown[]): number {
  if (rows.length === 0) {
    return EMPTY_RESULT_BYTES;
  }

  let sampled = 0;
  let sampledBytes = 0;
  for (let i = 0; i < Math.min(SAMPLE_SIZE, rows.length); i++) {
    try {
      sampledBytes += JSON.stringify(rows[i])?.length ?? 0;
    } catch {
      // Non-serializable row: charge a large nominal size so the entry trips the
      // per-entry cap rather than silently occupying the budget.
      return Number.MAX_SAFE_INTEGER;
    }
    sampled++;
  }

  const averageBytes = Math.max(1, Math.ceil(sampledBytes / sampled));
  return averageBytes * rows.length + PER_ENTRY_OVERHEAD_BYTES;
}

export function isExpired(updatedAt: number | undefined, ttlMs: number, now: number): boolean {
  if (ttlMs === Number.POSITIVE_INFINITY) {
    return false;
  }
  if (updatedAt === undefined) {
    // A missing timestamp must fail closed: treat it as maximally old rather than as
    // "just written" (which defaulting to 0 would do for any `now` under the ttl).
    return true;
  }
  return now - updatedAt > ttlMs;
}

/**
 * An empty result before the first completed sync is indistinguishable from "this
 * table is empty", and caching it paints an authoritative empty list on the next cold
 * boot. Everything else is cacheable.
 */
export function shouldPersistEmission(input: { rowCount: number; hasSynced: boolean | undefined }): boolean {
  return input.rowCount > 0 || input.hasSynced === true;
}

export interface EvictionCandidate {
  key: string;
  lastUsedAt: number;
  bytes: number;
}

/**
 * Selects least-recently-used entries to delete until the layer fits its budget.
 * TTL plays no part: budget pressure evicts regardless of freshness.
 */
export function selectEvictions(entries: readonly EvictionCandidate[], maxBytes: number): string[] {
  let total = 0;
  for (const entry of entries) {
    total += entry.bytes;
  }
  if (total <= maxBytes) {
    return [];
  }

  const byLeastRecentlyUsed = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const victims: string[] = [];
  for (const entry of byLeastRecentlyUsed) {
    if (total <= maxBytes) {
      break;
    }
    victims.push(entry.key);
    total -= entry.bytes;
  }
  return victims;
}
