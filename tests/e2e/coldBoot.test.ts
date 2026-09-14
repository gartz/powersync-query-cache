import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryCachePlugin } from '../../src/index.js';
import { IndexedDbQueryCacheStorage } from '../../src/idb/index.js';

const testSchema = new Schema({ assets: new Table({ make: column.text }) });

const databases: PowerSyncDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    if (!db.closed) {
      await db.close();
    }
  }
});

function openDatabase(dbFilename: string, cacheDatabaseName: string) {
  const db = new PowerSyncDatabase({
    schema: testSchema,
    database: { dbFilename },
    plugins: [
      new QueryCachePlugin({
        storage: new IndexedDbQueryCacheStorage({ databaseName: cacheDatabaseName }),
        debounceMs: 10
      })
    ]
  });
  databases.push(db);
  return db;
}

describe('query cache', () => {
  it('paints the previous result on a fresh database instance', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = openDatabase(dbFilename, cacheDatabaseName);
    await first.init();
    await first.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['cached-make']);

    const watched = first.query<{ make: string }>({ sql: 'SELECT make FROM assets' }).watch();
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.close();

    // A brand new instance: its memory layer is empty, so anything painted before the
    // live query resolves came from IndexedDB.
    const second = openDatabase(dbFilename, cacheDatabaseName);
    const reopened = second.query<{ make: string }>({ sql: 'SELECT make FROM assets' }).watch();

    // The cache-seeded state is transient: the plugin's IndexedDB hydrate and the live
    // SQLite query both start racing the instant the database reports ready, so the
    // window where state.source === 'cache' is typically single-digit milliseconds
    // before 'live' supersedes it. vi.waitFor's default 50ms poll interval is coarser
    // than that window, so poll finely here to reliably observe the transient state
    // rather than skip straight from 'placeholder' to 'live' between polls.
    await vi.waitFor(() => expect(reopened.state.source).toBe('cache'), { timeout: 5000, interval: 2 });
    expect(reopened.state.data).toEqual([{ make: 'cached-make' }]);
    expect(reopened.state.isLoading).toBe(false);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    expect(reopened.state.data).toEqual([{ make: 'cached-make' }]);
    await reopened.close();
  });

  it('disconnectAndClear wipes the cache', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = openDatabase(dbFilename, cacheDatabaseName);
    await first.init();
    await first.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['gone-after-logout']);

    const watched = first.query<{ make: string }>({ sql: 'SELECT make FROM assets' }).watch();
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();

    await first.disconnectAndClear();
    await first.close();

    const second = openDatabase(dbFilename, cacheDatabaseName);
    const reopened = second.query<{ make: string }>({ sql: 'SELECT make FROM assets' }).watch();

    // Nothing may paint from cache; the only data that can arrive is the (now empty) live result.
    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    expect(reopened.state.data).toEqual([]);
    await reopened.close();
  });

  it('honours a per-query opt-out', async () => {
    const dbFilename = `cache-${crypto.randomUUID()}.db`;
    const cacheDatabaseName = `cache-store-${crypto.randomUUID()}`;

    const first = openDatabase(dbFilename, cacheDatabaseName);
    await first.init();
    await first.execute('INSERT INTO assets(id, make) VALUES (uuid(), ?)', ['not-cached']);

    const watched = first
      .query<{ make: string }>({ sql: 'SELECT make FROM assets', extensions: { cache: false } })
      .watch();
    await vi.waitFor(() => expect(watched.state.data).toHaveLength(1), { timeout: 5000 });
    await watched.close();
    await first.close();

    const second = openDatabase(dbFilename, cacheDatabaseName);
    const reopened = second
      .query<{ make: string }>({ sql: 'SELECT make FROM assets', extensions: { cache: false } })
      .watch();

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    expect(reopened.state.source).not.toBe('cache');
    await reopened.close();
  });
});
