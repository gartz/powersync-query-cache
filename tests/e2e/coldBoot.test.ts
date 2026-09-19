import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedDifferentialWatch, createQueryCacheManager, disconnectAndClearWithCache } from '../../src/index.js';
import { IndexedDbQueryCacheStorage } from '../../src/idb/index.js';
import { computeCacheNamespace } from '../../src/namespace.js';
import type { QueryCacheManager } from '../../src/QueryCacheManager.js';

const testSchema = new Schema({ assets: new Table({ make: column.text }) });

const databases: PowerSyncDatabase[] = [];
const managers: QueryCacheManager[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const db of databases.splice(0)) {
    if (!db.closed) {
      await db.close();
    }
  }
});

/**
 * The cache is a combinator, not a plugin: the manager is built beside the database
 * rather than registered into it, so nothing about caching exists inside the SDK.
 */
async function openDatabase(dbFilename: string, cacheDatabaseName: string) {
  const db = new PowerSyncDatabase({ schema: testSchema, database: { dbFilename } });
  databases.push(db);

  const manager = createQueryCacheManager({
    options: {
      storage: new IndexedDbQueryCacheStorage({ databaseName: cacheDatabaseName }),
      debounceMs: 10
    },
    namespace: await computeCacheNamespace({
      databaseName: cacheDatabaseName,
      schemaJson: testSchema.toJSON(),
      version: '1',
      subtle: globalThis.crypto.subtle
    }),
    logger: (db as any).logger
  });
  managers.push(manager);

  return { db, manager };
}

const assetsQuery = {
  compile: () => ({ sql: 'SELECT make FROM assets', parameters: [] as any[] }),
  execute: ({ db }: any) => db.getAll('SELECT make FROM assets')
};

/**
 * Captures the full `state.source` history via the listener rather than polling. The
 * cache-seeded state can be transient — the IndexedDB read and the live SQLite query
 * race each other — so a poll can miss it even when it genuinely occurred, and can never
 * prove a state did NOT occur. `onStateChange` only fires on updates, so the constructed
 * state is seeded into the history up front.
 */
function trackSourceHistory(query: { state: { source: string }; registerListener: (l: any) => () => void }) {
  const history: string[] = [query.state.source];
  const dispose = query.registerListener({
    onStateChange: (state: { source: string }) => {
      if (state.source !== history[history.length - 1]) {
        history.push(state.source);
      }
    }
  });
  return { history, dispose };
}

describe('query cache combinator', () => {
  it('paints the previous result on a fresh database instance', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = await openDatabase(dbFilename, cacheDatabaseName);
    await first.db.init();
    await first.db.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['cached-make']);

    const watched = cachedDifferentialWatch<{ make: string }>(first.manager, first.db as any, assetsQuery);
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.manager.flush();
    await first.db.close();

    // A brand new instance: its memory layer is empty, so anything painted before the
    // live query resolves came from IndexedDB.
    const second = await openDatabase(dbFilename, cacheDatabaseName);
    const reopened = cachedDifferentialWatch<{ make: string }>(second.manager, second.db as any, assetsQuery);
    const { history, dispose } = trackSourceHistory(reopened);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    expect(history).toContain('cache');
    expect(history.indexOf('cache')).toBeLessThan(history.indexOf('live'));
    expect(reopened.state.data).toEqual([{ make: 'cached-make' }]);
    await reopened.close();
  });

  it('seeds the diff baseline, so an unchanged row is not re-reported as an insert', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = await openDatabase(dbFilename, cacheDatabaseName);
    await first.db.init();
    await first.db.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['stable']);

    const watched = cachedDifferentialWatch<{ make: string }>(first.manager, first.db as any, assetsQuery);
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.manager.flush();
    await first.db.close();

    const second = await openDatabase(dbFilename, cacheDatabaseName);
    const reopened = cachedDifferentialWatch<{ make: string }>(second.manager, second.db as any, assetsQuery);

    const diffs: any[] = [];
    reopened.registerListener({ onDiff: (diff: any) => void diffs.push(diff) });

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });

    // The property `initialData` buys: the row was already on screen from the cache, so
    // the live result must not present it as newly added.
    const added = diffs.flatMap((d) => d.added);
    expect(added).toEqual([]);
    await reopened.close();
  });

  it('disconnectAndClear wipes the cache', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = await openDatabase(dbFilename, cacheDatabaseName);
    await first.db.init();
    await first.db.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['gone-after-logout']);

    const watched = cachedDifferentialWatch<{ make: string }>(first.manager, first.db as any, assetsQuery);
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.manager.flush();

    // The cache cannot observe a logout from outside the SDK, so clearing is explicit.
    await disconnectAndClearWithCache(first.db as any, first.manager);
    await first.db.close();

    const second = await openDatabase(dbFilename, cacheDatabaseName);
    const reopened = cachedDifferentialWatch<{ make: string }>(second.manager, second.db as any, assetsQuery);
    const { history, dispose } = trackSourceHistory(reopened);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    // Cached rows outliving a logout would leave one user's data readable by the next.
    expect(history).not.toContain('cache');
    expect(reopened.state.data).toEqual([]);
    await reopened.close();
  });

  it('honours a per-query opt-out', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = await openDatabase(dbFilename, cacheDatabaseName);
    await first.db.init();
    await first.db.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['not-cached']);

    const watched = cachedDifferentialWatch<{ make: string }>(first.manager, first.db as any, assetsQuery, {
      cache: false
    });
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.manager.flush();
    await first.db.close();

    const second = await openDatabase(dbFilename, cacheDatabaseName);
    const reopened = cachedDifferentialWatch<{ make: string }>(second.manager, second.db as any, assetsQuery, {
      cache: false
    });
    const { history, dispose } = trackSourceHistory(reopened);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    expect(history).not.toContain('cache');
    await reopened.close();
  });
});
