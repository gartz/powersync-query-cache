import { describe, expect, it } from 'vitest';
import { MemoryQueryCache } from '../src/MemoryQueryCache.js';

const entry = (rows: unknown[], bytes: number, updatedAt = 1000) => ({
  rows,
  bytes,
  updatedAt,
  lastUsedAt: updatedAt
});

describe('MemoryQueryCache', () => {
  it('returns what was stored', () => {
    const cache = new MemoryQueryCache(1000);
    cache.set('sig', entry([{ id: 1 }], 50));
    expect(cache.get('sig', 2000)?.rows).toEqual([{ id: 1 }]);
  });

  it('returns undefined for a miss', () => {
    expect(new MemoryQueryCache(1000).get('nope', 1)).toBeUndefined();
  });

  it('renews lastUsedAt on read', () => {
    const cache = new MemoryQueryCache(1000);
    cache.set('sig', entry([{ id: 1 }], 50, 1000));
    cache.get('sig', 5000);
    expect(cache.get('sig', 6000)?.lastUsedAt).toBe(6000);
  });

  it('evicts least-recently-used when over budget', () => {
    const cache = new MemoryQueryCache(100);
    cache.set('a', entry([], 40, 1));
    cache.set('b', entry([], 40, 2));
    cache.get('a', 3); // 'a' is now the most recently used
    cache.set('c', entry([], 40, 4));

    expect(cache.get('b', 5)).toBeUndefined();
    expect(cache.get('a', 5)).toBeDefined();
    expect(cache.get('c', 5)).toBeDefined();
  });

  it('tracks total bytes across set and delete', () => {
    const cache = new MemoryQueryCache(1000);
    cache.set('a', entry([], 40));
    cache.set('b', entry([], 60));
    expect(cache.totalBytes).toBe(100);
    cache.delete('a');
    expect(cache.totalBytes).toBe(60);
  });

  it('replacing a key does not double count', () => {
    const cache = new MemoryQueryCache(1000);
    cache.set('a', entry([], 40));
    cache.set('a', entry([], 70));
    expect(cache.totalBytes).toBe(70);
    expect(cache.size).toBe(1);
  });

  it('clear empties everything', () => {
    const cache = new MemoryQueryCache(1000);
    cache.set('a', entry([], 40));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it('refuses an entry larger than the whole budget', () => {
    const cache = new MemoryQueryCache(100);
    cache.set('huge', entry([], 500));
    expect(cache.get('huge', 1)).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });
});
