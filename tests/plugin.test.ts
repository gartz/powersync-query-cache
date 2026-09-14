import { createConsoleLogger, DatabasePluginContext, LogLevels } from '@powersync/common';
import { describe, expect, it, vi } from 'vitest';
import { getCacheMeta, QueryCachePlugin } from '../src/plugin.js';
import { FakeQueryCacheStorage } from './FakeQueryCacheStorage.js';

const logger = createConsoleLogger({ minLevel: LogLevels.error });

function openPlugin(storage: FakeQueryCacheStorage, options?: { encryptionKey?: string }) {
  const plugin = new QueryCachePlugin({ storage, debounceMs: 0, ...options });
  const listeners = new Set<any>();
  const db = {
    logger,
    database: { name: 'app.db' },
    schema: { toJSON: () => ({ tables: [] }) },
    currentStatus: { hasSynced: true },
    registerListener: (l: any) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }
  };
  const disposer = plugin.onDatabaseOpen({ db: db as any, logger } as DatabasePluginContext);
  return { plugin, db, listeners, disposer };
}

const ctx = (overrides?: Partial<{ dataIsArray: boolean; extensionOptions: unknown }>) => ({
  signature: 'SELECT * FROM items\0[]',
  compiled: { sql: 'SELECT * FROM items', parameters: [] },
  dataIsArray: true,
  extensionOptions: undefined,
  db: {} as any,
  ...overrides
});

describe('QueryCachePlugin', () => {
  it('ignores non-array queries', () => {
    const { plugin } = openPlugin(new FakeQueryCacheStorage());
    expect(plugin.onWatchedQueryCreate(ctx({ dataIsArray: false }))).toBeUndefined();
  });

  it('honours a per-query opt-out via extensionOptions', () => {
    const { plugin } = openPlugin(new FakeQueryCacheStorage());
    expect(plugin.onWatchedQueryCreate(ctx({ extensionOptions: false }))).toBeUndefined();
  });

  it('records live array results and seeds them back through onLink', async () => {
    const storage = new FakeQueryCacheStorage();
    const first = openPlugin(storage);
    const hooks = first.plugin.onWatchedQueryCreate(ctx())!;

    hooks.onResult!([{ id: 1 }], { hasSynced: true, dataIsArray: true });
    await first.plugin.flush();
    expect(storage.writes.length).toBe(1);

    // A second plugin instance (fresh memory, same storage) hydrates it.
    const second = openPlugin(storage);
    const secondHooks = second.plugin.onWatchedQueryCreate(ctx())!;

    const adopted = vi.fn(() => true);
    secondHooks.onLink!(adopted as any, new AbortController().signal);
    await vi.waitFor(() => expect(adopted).toHaveBeenCalled());

    const seeded = adopted.mock.calls[0]![0] as any;
    expect(seeded.data).toEqual([{ id: 1 }]);
    expect(seeded.source).toBe('cache');
    expect(seeded.sourceMeta.cachedAt).toBeInstanceOf(Date);
  });

  it('seedInitial serves the memory layer synchronously within one instance', async () => {
    const storage = new FakeQueryCacheStorage();
    const { plugin } = openPlugin(storage);
    const hooks = plugin.onWatchedQueryCreate(ctx())!;

    hooks.onResult!([{ id: 7 }], { hasSynced: true, dataIsArray: true });
    const seed = plugin.onWatchedQueryCreate(ctx())!.seedInitial!();
    expect(seed?.data).toEqual([{ id: 7 }]);
    expect(seed?.source).toBe('cache');
  });

  it('clears everything when the database fires cleared', async () => {
    const storage = new FakeQueryCacheStorage();
    const { plugin, listeners } = openPlugin(storage);
    const hooks = plugin.onWatchedQueryCreate(ctx())!;
    hooks.onResult!([{ id: 1 }], { hasSynced: true, dataIsArray: true });
    await plugin.flush();

    for (const listener of listeners) {
      listener.cleared?.();
    }
    await vi.waitFor(() => expect(storage.clearCalls).toBe(1));
    expect(plugin.onWatchedQueryCreate(ctx())!.seedInitial!()).toBeUndefined();
  });

  it('getCacheMeta narrows sourceMeta only for cache states', () => {
    const cachedAt = new Date();
    expect(getCacheMeta({ source: 'cache', sourceMeta: { cachedAt } } as any)).toEqual({ cachedAt });
    expect(getCacheMeta({ source: 'live', sourceMeta: null } as any)).toBeUndefined();
  });
});
