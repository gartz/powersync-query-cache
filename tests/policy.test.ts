import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY_CACHE_CONFIG,
  estimateRowsBytes,
  isExpired,
  resolveCacheForQuery,
  resolveQueryCacheConfig,
  selectEvictions,
  shouldPersistEmission
} from '../src/policy.js';

const storage = {} as any;

describe('resolveQueryCacheConfig', () => {
  it('is disabled when no options are given', () => {
    expect(resolveQueryCacheConfig(undefined).enabled).toBe(false);
  });

  it('enables by default when storage is supplied', () => {
    expect(resolveQueryCacheConfig({ storage }).enabled).toBe(true);
  });

  it('honours an explicit disable', () => {
    expect(resolveQueryCacheConfig({ storage, enabled: false }).enabled).toBe(false);
  });

  it('fills defaults for omitted values', () => {
    const config = resolveQueryCacheConfig({ storage });
    expect(config.ttlMs).toBe(DEFAULT_QUERY_CACHE_CONFIG.ttlMs);
    expect(config.memoryMaxBytes).toBe(DEFAULT_QUERY_CACHE_CONFIG.memoryMaxBytes);
    expect(config.persistedMaxBytes).toBe(DEFAULT_QUERY_CACHE_CONFIG.persistedMaxBytes);
    expect(config.debounceMs).toBe(DEFAULT_QUERY_CACHE_CONFIG.debounceMs);
  });
});

describe('resolveCacheForQuery', () => {
  const enabled = resolveQueryCacheConfig({ storage });
  const disabled = resolveQueryCacheConfig({ storage, enabled: false });

  it('inherits the global setting when the query says nothing', () => {
    expect(resolveCacheForQuery(enabled, undefined).enabled).toBe(true);
    expect(resolveCacheForQuery(disabled, undefined).enabled).toBe(false);
  });

  it('opts out of an enabled cache', () => {
    expect(resolveCacheForQuery(enabled, false).enabled).toBe(false);
  });

  it('opts in to a disabled cache', () => {
    expect(resolveCacheForQuery(disabled, true).enabled).toBe(true);
  });

  it('overrides the ttl per query', () => {
    expect(resolveCacheForQuery(enabled, { ttlMs: 1000 }).ttlMs).toBe(1000);
  });

  it('keeps the global ttl when the override only sets enabled', () => {
    expect(resolveCacheForQuery(enabled, { enabled: true }).ttlMs).toBe(enabled.ttlMs);
  });
});

describe('estimateRowsBytes', () => {
  it('returns a small constant for an empty result', () => {
    expect(estimateRowsBytes([])).toBeLessThan(128);
  });

  it('scales with row count', () => {
    const row = { id: 'abcdefgh', name: 'a name', count: 12 };
    const ten = estimateRowsBytes(Array.from({ length: 10 }, () => row));
    const hundred = estimateRowsBytes(Array.from({ length: 100 }, () => row));
    expect(hundred).toBeGreaterThan(ten * 8);
  });

  it('never returns zero for non-empty rows', () => {
    expect(estimateRowsBytes([{}])).toBeGreaterThan(0);
  });
});

describe('isExpired', () => {
  it('is false inside the window', () => {
    expect(isExpired(1000, 500, 1400)).toBe(false);
  });
  it('is true past the window', () => {
    expect(isExpired(1000, 500, 1600)).toBe(true);
  });
  it('treats a missing timestamp as maximally old', () => {
    expect(isExpired(undefined, 500, 1)).toBe(true);
  });
  it('never expires with an infinite ttl', () => {
    expect(isExpired(0, Number.POSITIVE_INFINITY, 1e15)).toBe(false);
  });
});

describe('shouldPersistEmission', () => {
  it('rejects an empty result before first sync', () => {
    expect(shouldPersistEmission({ rowCount: 0, hasSynced: false })).toBe(false);
  });
  it('accepts an empty result after first sync', () => {
    expect(shouldPersistEmission({ rowCount: 0, hasSynced: true })).toBe(true);
  });
  it('accepts a non-empty result before first sync', () => {
    expect(shouldPersistEmission({ rowCount: 3, hasSynced: false })).toBe(true);
  });
  it('treats unknown sync state as not synced', () => {
    expect(shouldPersistEmission({ rowCount: 0, hasSynced: undefined })).toBe(false);
  });
});

describe('selectEvictions', () => {
  const entry = (key: string, lastUsedAt: number, bytes: number) => ({ key, lastUsedAt, bytes });

  it('evicts nothing under budget', () => {
    expect(selectEvictions([entry('a', 1, 10), entry('b', 2, 10)], 100)).toEqual([]);
  });

  it('evicts least-recently-used first until under budget', () => {
    const entries = [entry('old', 1, 40), entry('mid', 2, 40), entry('new', 3, 40)];
    expect(selectEvictions(entries, 100)).toEqual(['old']);
  });

  it('evicts as many as needed', () => {
    const entries = [entry('a', 1, 40), entry('b', 2, 40), entry('c', 3, 40)];
    expect(selectEvictions(entries, 45)).toEqual(['a', 'b']);
  });

  it('ignores ttl entirely', () => {
    const entries = [entry('fresh-but-cold', 1, 80), entry('stale-but-hot', 9, 80)];
    expect(selectEvictions(entries, 100)).toEqual(['fresh-but-cold']);
  });
});
