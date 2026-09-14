import { createConsoleLogger, LogLevels } from '@powersync/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEnvelope } from '../src/codec.js';
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
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    expect(manager.peek(SIGNATURE, 1000)).toBeUndefined();
  });

  it('serves a recorded result from memory synchronously', () => {
    const manager = createManager(new FakeQueryCacheStorage());
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    expect(manager.peek(SIGNATURE, 60_000)?.rows).toEqual([{ id: 1 }]);
  });

  it('does not serve an expired memory entry', () => {
    const manager = createManager(new FakeQueryCacheStorage());
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    vi.advanceTimersByTime(50);
    expect(manager.peek(SIGNATURE, 10)).toBeUndefined();
  });

  it('skips an empty result before first sync', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [], { hasSynced: false });
    await manager.flush();
    expect(storage.writes).toHaveLength(0);
  });

  it('persists after the debounce, collapsing rapid emissions', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);

    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    manager.record(SIGNATURE, [{ id: 2 }], { hasSynced: true });
    expect(storage.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));

    const key = await persistedKeyFor(NAMESPACE, SIGNATURE, crypto.subtle);
    const entry = storage.entries.get(key)!;
    expect(entry.namespace).toBe(NAMESPACE);
    // The signature rides inside the payload, never beside it.
    expect(entry).not.toHaveProperty('signature');
    expect(decodeEnvelope(entry.payload)?.signature).toBe(SIGNATURE);
  });

  it('keeps the query text out of every persisted field when encrypted', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage, { encryptionKey: 'db-key' });
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    await manager.flush();

    const entry = [...storage.entries.values()][0];
    // Anything written in the clear — key, namespace, timestamps — must not leak the
    // SQL or its parameters; the hashed key is pointless if the SQL sits next to it.
    const cleartext = JSON.stringify({ ...entry, payload: undefined, iv: undefined });
    expect(cleartext).not.toContain('SELECT');
    expect(cleartext).not.toContain('items');
    expect(new TextDecoder().decode(entry.payload)).not.toContain('SELECT');
  });

  it('hydrates a persisted result into memory', async () => {
    const storage = new FakeQueryCacheStorage();
    const writer = createManager(storage);
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true });
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
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true });
    await writer.flush();

    vi.advanceTimersByTime(5000);
    const reader = createManager(storage);
    expect(await reader.hydrate(SIGNATURE, 1000)).toBeUndefined();
    expect(storage.deletes.flat()).toHaveLength(1);
  });

  it('discards an entry whose sealed signature does not match', async () => {
    const storage = new FakeQueryCacheStorage();
    const writer = createManager(storage);
    writer.record(SIGNATURE, [{ id: 7 }], { hasSynced: true });
    await writer.flush();

    // Simulate a key-hash collision: move this entry to the key another query hashes to.
    const other = 'SELECT something-else\0[]';
    const key = await persistedKeyFor(NAMESPACE, SIGNATURE, crypto.subtle);
    const collidingKey = await persistedKeyFor(NAMESPACE, other, crypto.subtle);
    const written = storage.entries.get(key)!;
    storage.entries.delete(key);
    storage.entries.set(collidingKey, { ...written, key: collidingKey });

    const reader = createManager(storage);
    expect(await reader.hydrate(other, 60_000)).toBeUndefined();
    expect(storage.deletes.flat()).toContain(collidingKey);
  });

  it('discards a persisted record written in an older payload format', async () => {
    const storage = new FakeQueryCacheStorage();
    const key = await persistedKeyFor(NAMESPACE, SIGNATURE, crypto.subtle);
    storage.entries.set(key, {
      key,
      namespace: NAMESPACE,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
      bytes: 10,
      // A bare rows array, as an earlier build wrote.
      payload: new TextEncoder().encode('[{"id":7}]')
    });

    const reader = createManager(storage);
    expect(await reader.hydrate(SIGNATURE, 60_000)).toBeUndefined();
    expect(storage.deletes.flat()).toContain(key);
  });

  it('encrypts payloads when an encryption key is configured', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage, { encryptionKey: 'db-key' });
    manager.record(SIGNATURE, [{ secret: 'classified' }], { hasSynced: true });
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
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    await manager.flush();

    storage.entries.set('foreign', {
      key: 'foreign',
      namespace: 'someone-else',
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
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    await manager.flush();

    await manager.clear();
    expect(manager.peek(SIGNATURE, 60_000)).toBeUndefined();
    expect(storage.clearCalls).toBe(1);
    expect(storage.published).toEqual([{ type: 'all' }]);
  });

  it('flush() and close() wait for an in-flight clear to finish', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    let release: () => void = () => {};
    storage.blockClear = new Promise<void>((resolve) => (release = resolve));

    // `disconnectAndClear()` fires the plugin's `cleared` listener without awaiting the
    // promise it returns, so this is exactly how clear() is called in production.
    const order: string[] = [];
    const clearing = manager.clear().then(() => void order.push('clear'));
    const flushing = manager.flush().then(() => void order.push('flush'));

    // Drain microtasks: the manager has reached storage.clear() and is stuck in it.
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.clearCalls).toBe(0);
    expect(order).toEqual([]);

    release();
    await Promise.all([clearing, flushing]);
    expect(storage.clearCalls).toBe(1);
    // The wipe settled first; flush() could not have resolved before it.
    expect(order[0]).toBe('clear');
  });

  it('drops the memory layer when another context invalidates', async () => {
    const storage = new FakeQueryCacheStorage();
    const manager = createManager(storage);
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    await manager.flush();

    storage.receiveInvalidation({ type: 'all' });
    expect(manager.peek(SIGNATURE, 60_000)).toBeUndefined();
  });

  it('never throws when storage fails, and stops using it', async () => {
    const storage = new FakeQueryCacheStorage();
    storage.failEverything = true;
    const manager = createManager(storage);

    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
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

    manager.record('bad\0[]', [{ fn: () => 1 }], { hasSynced: true });
    manager.record(SIGNATURE, [{ id: 1 }], { hasSynced: true });
    await manager.flush();

    expect(storage.writes).toHaveLength(1);
  });
});
