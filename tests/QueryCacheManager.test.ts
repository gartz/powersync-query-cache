import { createConsoleLogger, LogLevels } from '@powersync/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryCacheManager } from '../src/QueryCacheManager.js';
import { persistedKeyFor } from '../src/keys.js';
import { FakeQueryCacheStorage } from './FakeQueryCacheStorage.js';

const logger = createConsoleLogger({ minLevel: LogLevels.error });
const SIGNATURE = 'SELECT * FROM items\0[]';
const NAMESPACE = 'test-namespace';

function createManager(storage: FakeQueryCacheStorage, overrides?: { encryptionKey?: string }) {
  return createQueryCacheManager({
    options: { storage, debounceMs: 100, encryptionKey: overrides?.encryptionKey },
    namespace: Promise.resolve(NAMESPACE),
    logger
  });
}

describe('QueryCacheManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is disabled without storage', () => {
    const manager = createQueryCacheManager({
      options: undefined,
      namespace: Promise.resolve(NAMESPACE),
      logger
    });
    expect(manager.enabled).toBe(false);
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 1000 });
    expect(manager.peek(SIGNATURE, 1000)).toBeUndefined();
  });

  it('serves a recorded result from memory synchronously', () => {
    const manager = createManager(new FakeQueryCacheStorage());
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    expect(manager.peek(SIGNATURE, 60_000)?.rows).toEqual([{ id: 1 }]);
  });

  it('does not serve an expired memory entry', () => {
    const manager = createManager(new FakeQueryCacheStorage());
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 10 });
    vi.advanceTimersByTime(50);
    expect(manager.peek(SIGNATURE, 10)).toBeUndefined();
  });

  it('skips an empty result before first sync', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [], { hasSynced: false, ttlMs: 60_000 });
    await manager.flush();
    expect(storage.writes).toHaveLength(0);
  });

  it('persists after the debounce, collapsing rapid emissions', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);

    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    manager.record(SIGNATURE, [{ id: 2 }], { hasSynced: true, ttlMs: 60_000 });
    expect(storage.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));

    const key = await persistedKeyFor(NAMESPACE, SIGNATURE, crypto.subtle);
    const entry = storage.entries.get(key)!;
    expect(entry.signature).toBe(SIGNATURE);
    expect(entry.namespace).toBe(NAMESPACE);
  });

  it('hydrates a persisted result into memory', async () => {
    const storage = new FakeQueryCacheStorage();
    const writer = createManager(storage);
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true, ttlMs: 60_000 });
    await writer.flush();

    const reader = createManager(storage);
    const hit = await reader.hydrate(SIGNATURE, 60_000);
    expect(hit?.rows).toEqual([{ id: 7 }]);
    expect(hit?.cachedAt).toBeInstanceOf(Date);
    expect(reader.peek(SIGNATURE, 60_000)?.rows).toEqual([{ id: 7 }]);
  });

  it('drops and deletes an expired persisted entry', async () => {
    const storage = new FakeQueryCacheStorage();
    const writer = createManager(storage);
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true, ttlMs: 60_000 });
    await writer.flush();

    vi.advanceTimersByTime(5000);
    const reader = createManager(storage);
    expect(await reader.hydrate(SIGNATURE, 1000)).toBeUndefined();
    expect(storage.deletes.flat()).toHaveLength(1);
  });

  it('discards an entry whose signature does not match', async () => {
    const storage = new FakeQueryCacheStorage();
    const writer = createManager(storage);
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true, ttlMs: 60_000 });
    await writer.flush();

    const key = await persistedKeyFor(NAMESPACE, SIGNATURE, crypto.subtle);
    storage.entries.get(key)!.signature = 'SELECT something-else\0[]';

    const reader = createManager(storage);
    expect(await reader.hydrate(SIGNATURE, 60_000)).toBeUndefined();
    expect(storage.deletes.flat()).toContain(key);
  });

  it('encrypts payloads when an encryption key is configured', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage, { encryptionKey: 'db-key' });
    manager.record(SIGNATURE, [{ secret: 'classified' }], { hasSynced: true, ttlMs: 60_000 });
    await manager.flush();

    const entry = [...storage.entries.values()][0];
    expect(entry.iv).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(entry.payload)).not.toContain('classified');

    const reader = createManager(storage, { encryptionKey: 'db-key' });
    expect((await reader.hydrate(SIGNATURE, 60_000))?.rows).toEqual([{ secret: 'classified' }]);
  });

  it('prunes entries from other namespaces', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    await manager.flush();

    storage.entries.set('foreign', {
      key: 'foreign',
      namespace: 'someone-else',
      signature: SIGNATURE,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
      bytes: 10,
      payload: new Uint8Array()
    });

    await manager.pruneForeign();
    expect(storage.entries.has('foreign')).toBe(false);
    expect(storage.entries.size).toBe(1);
  });

  it('clear empties both layers and publishes an invalidation', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    await manager.flush();

    await manager.clear();
    expect(manager.peek(SIGNATURE, 60_000)).toBeUndefined();
    expect(storage.clearCalls).toBe(1);
    expect(storage.published).toEqual([{ type: 'all' }]);
  });

  it('drops the memory layer when another context invalidates', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    await manager.flush();

    storage.receiveInvalidation({ type: 'all' });
    expect(manager.peek(SIGNATURE, 60_000)).toBeUndefined();
  });

  it('never throws when storage fails, and stops using it', async () => {
    const storage = new FakeQueryCacheStorage();
    storage.failEverything = true;
    const manager = createManager(storage);

    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    await expect(manager.flush()).resolves.toBeUndefined();
    await expect(manager.hydrate(SIGNATURE, 60_000)).resolves.toBeUndefined();

    // Memory still works — only the persistent layer is disabled.
    expect(manager.peek(SIGNATURE, 60_000)?.rows).toEqual([{ id: 1 }]);
  });

  it('gives up on a storage whose open never settles', async () => {
    const storage = new FakeQueryCacheStorage();
    storage.hangOnOpen = true;
    const manager = createManager(storage);

    const hydrate = manager.hydrate(SIGNATURE, 60_000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(hydrate).resolves.toBeUndefined();
  });

  it('skips a result it cannot encode, without disabling the cache', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);

    manager.record('bad\0[]', [{ fn: () => 1 }], { hasSynced: true, ttlMs: 60_000 });
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true, ttlMs: 60_000 });
    await manager.flush();

    expect(storage.writes).toHaveLength(1);
  });
});
