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

/**
 * Captures the full `state.source` history of a watched query via its listener, rather
 * than polling a point-in-time snapshot. The cache-seeded state can be transient (the
 * plugin's IndexedDB hydrate and the live SQLite query both start racing the instant the
 * database reports ready), so a poll-based assertion can miss it entirely even when it
 * genuinely occurred — and, symmetrically, can never prove a state did NOT occur. A
 * listener sees every transition, so it can assert both presence/ordering and absence.
 *
 * `onStateChange` only fires on updates, so the state as constructed (synchronous, before
 * any listener could be registered) is captured up front and seeded into the history.
 */
function trackSourceHistory(query: { state: { source: string }; registerListener: (l: any) => () => void }) {
  const history: string[] = [query.state.source];
  const dispose = query.registerListener({
    onStateChange: (state: { source: string }) => {
      const last = history[history.length - 1];
      if (state.source !== last) {
        history.push(state.source);
      }
    }
  });
  return { history, dispose };
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
    const { history, dispose } = trackSourceHistory(reopened);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    expect(history).toContain('cache');
    expect(history.indexOf('cache')).toBeLessThan(history.indexOf('live'));
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
    const { history, dispose } = trackSourceHistory(reopened);

    // Nothing may paint from cache; the only data that can arrive is the (now empty) live result.
    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    expect(history).not.toContain('cache');
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
    // A point-in-time check can only ever see the state it happens to land on; a cache
    // paint here would be transient and could be overwritten by the live result before
    // the poll fires. The history sees every transition, so it can prove absence.
    const { history, dispose } = trackSourceHistory(reopened);

    await vi.waitFor(() => expect(reopened.state.source).toBe('live'), { timeout: 5000 });
    dispose();

    expect(history).not.toContain('cache');
    expect(reopened.state.data).toEqual([{ make: 'not-cached' }]);
    await reopened.close();
  });
});
