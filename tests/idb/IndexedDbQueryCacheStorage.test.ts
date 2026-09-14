import { QueryCacheEntry } from '../../src/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbQueryCacheStorage } from '../../src/idb/IndexedDbQueryCacheStorage.js';

const stores: IndexedDbQueryCacheStorage[] = [];

function createStorage() {
  const storage = new IndexedDbQueryCacheStorage({ databaseName: `test-${crypto.randomUUID()}` });
  stores.push(storage);
  return storage;
}

function entry(overrides?: Partial<QueryCacheEntry>): QueryCacheEntry {
  return {
    key: 'key-1',
    namespace: 'ns',
    updatedAt: 1000,
    lastUsedAt: 1000,
    bytes: 12,
    payload: new TextEncoder().encode('[{"id":1}]'),
    ...overrides
  };
}

afterEach(async () => {
  for (const storage of stores.splice(0)) {
    await storage.dispose();
  }
});

describe('IndexedDbQueryCacheStorage', () => {
  it('round-trips an entry', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry());

    const read = await storage.read('key-1');
    expect(read?.namespace).toBe('ns');
    expect(new TextDecoder().decode(read!.payload)).toBe('[{"id":1}]');
    // Nothing about the query itself is stored outside the sealed payload.
    expect(read).not.toHaveProperty('signature');
  });

  it('preserves the IV for encrypted entries', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry({ iv: new Uint8Array([1, 2, 3]) }));

    const read = await storage.read('key-1');
    expect([...read!.iv!]).toEqual([1, 2, 3]);
  });

  it('returns undefined for a missing key', async () => {
    const storage = createStorage();
    await storage.open();
    expect(await storage.read('nope')).toBeUndefined();
  });

  it('lists metadata without payloads', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry({ key: 'a' }));
    await storage.write(entry({ key: 'b', namespace: 'other' }));

    const meta = await storage.listMeta();
    expect(meta.map((m) => m.key).sort()).toEqual(['a', 'b']);
    expect((meta[0] as any).payload).toBeUndefined();
  });

  it('deletes metadata and payload together', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry({ key: 'a' }));
    await storage.deleteKeys(['a']);

    expect(await storage.read('a')).toBeUndefined();
    expect(await storage.listMeta()).toHaveLength(0);
  });

  it('applies batched touches', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry({ key: 'a', lastUsedAt: 1000 }));
    await storage.write(entry({ key: 'b', lastUsedAt: 1000 }));

    await storage.touch([
      { key: 'a', lastUsedAt: 5000 },
      { key: 'b', lastUsedAt: 6000 }
    ]);

    const meta = await storage.listMeta();
    expect(meta.find((m) => m.key === 'a')?.lastUsedAt).toBe(5000);
    expect(meta.find((m) => m.key === 'b')?.lastUsedAt).toBe(6000);
  });

  it('ignores touches for entries that no longer exist', async () => {
    const storage = createStorage();
    await storage.open();
    await expect(storage.touch([{ key: 'gone', lastUsedAt: 1 }])).resolves.toBeUndefined();
  });

  it('clears everything', async () => {
    const storage = createStorage();
    await storage.open();
    await storage.write(entry({ key: 'a' }));
    await storage.clear();

    expect(await storage.listMeta()).toHaveLength(0);
    expect(await storage.read('a')).toBeUndefined();
  });

  it('survives a reopen', async () => {
    const databaseName = `test-${crypto.randomUUID()}`;
    const first = new IndexedDbQueryCacheStorage({ databaseName });
    await first.open();
    await first.write(entry({ key: 'persisted' }));
    await first.dispose();

    const second = new IndexedDbQueryCacheStorage({ databaseName });
    stores.push(second);
    await second.open();
    expect(await second.read('persisted')).toBeDefined();
  });
});
