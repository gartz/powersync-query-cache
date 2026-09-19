import { commands } from '@vitest/browser/context';
import { createConsoleLogger, LogLevels } from '@powersync/common';
import {
  column,
  PowerSyncDatabase,
  Schema,
  Table,
  WASQLiteOpenFactory,
  WASQLiteVFS
} from '@powersync/web';
import { describe, expect, it } from 'vitest';
import { QueryCachePlugin } from '../../src/index.js';
import { IndexedDbQueryCacheStorage } from '../../src/idb/index.js';

/**
 * Cold-start breakdown: of the time a refreshed page spends before it can show a row,
 * which step actually costs the most?
 *
 * The size matrix answers "how long"; this answers "spent where", because the two lead
 * to different fixes. If the dominant cost is the query, faster SQLite and raw tables
 * solve it. If it is asset fetch, WASM compilation, worker startup or the file-system
 * handshake, none of those help — that time is spent before SQLite is in a position to
 * answer anything at all.
 *
 * The decomposition uses only public API plus resource timing, measured on the FIRST
 * database opened in the page (later opens reuse the fetched and compiled module, so
 * only the first one reflects a refresh):
 *
 *  Phase A — `adapterOpenMs`: a bare `WASQLiteOpenFactory` adapter, opened and asked for
 *    one trivial statement, with no `PowerSyncDatabase` around it. This is worker spawn +
 *    worker script fetch + wa-sqlite fetch and compile + VFS handshake + one round trip.
 *    Resource timing then splits the two network components out of it by name.
 *
 *  Phase B — `powerSyncInitMs`: `new PowerSyncDatabase()` until `init()` resolves, on a
 *    page where the module is already warm. Against phase A this isolates what PowerSync
 *    itself adds on top of opening a database: `loadVersion`, `updateSchema`,
 *    `resolveOfflineSyncStatus`, the recursive-triggers pragma and trigger cleanup.
 *
 *  Phase C — `firstQueryMs`: ready database until the dashboard query has rows. The only
 *    phase that scales with dataset size.
 *
 *  Phase D — `cacheReadMs`: the cached paint on the same page, for scale.
 *
 * Not measured: connecting to a sync backend. These runs have no backend connector, so
 * network sync is absent from every number here — which understates a real cold start
 * rather than flattering the cache.
 */

const testSchema = new Schema({
  items: new Table({ seq: column.integer, payload: column.text })
});

const BENCH_QUERY = 'SELECT id, seq, substr(payload, 1, 64) AS preview FROM items ORDER BY seq DESC LIMIT 50';
const SIZE_MB = Number((import.meta as any).env?.VITE_BENCH_SIZE_MB ?? 50);
const BATCH_ROWS = 2000;

const BENCH_VFS = ((import.meta as any).env?.VITE_BENCH_VFS as WASQLiteVFS) ?? WASQLiteVFS.IDBBatchAtomicVFS;
const BENCH_READERS = Number((import.meta as any).env?.VITE_BENCH_READERS ?? 1);
const BENCH_CPU_THROTTLE = Number((import.meta as any).env?.VITE_BENCH_CPU_THROTTLE ?? 1);

const dbFilename = `coldstart-${crypto.randomUUID()}.db`;
const cacheDatabaseName = `coldstart-cache-${crypto.randomUUID()}`;

interface ResourcePhase {
  name: string;
  startMs: number;
  durationMs: number;
  transferBytes: number;
  decodedBytes: number;
}

/**
 * Resource entries recorded since `since`, for the assets the database open pulls in.
 * `transferBytes` of 0 with a non-zero decoded size means it came from the HTTP cache —
 * worth knowing, because a refresh usually does hit the cache and a first visit does not.
 */
function resourcePhases(since: number): ResourcePhase[] {
  return performance
    .getEntriesByType('resource')
    .filter((e) => e.startTime >= since)
    .filter((e) => /\.wasm($|\?)|worker|sqlite/i.test(e.name))
    .map((e) => {
      const r = e as PerformanceResourceTiming;
      return {
        name: r.name.split('/').slice(-1)[0].slice(0, 80),
        startMs: r.startTime - since,
        durationMs: r.duration,
        transferBytes: r.transferSize ?? 0,
        decodedBytes: r.decodedBodySize ?? 0
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

function openDatabase(withCache: boolean) {
  const plugin = withCache
    ? new QueryCachePlugin({
        storage: new IndexedDbQueryCacheStorage({ databaseName: cacheDatabaseName }),
        debounceMs: 10
      })
    : undefined;
  const db = new PowerSyncDatabase({
    schema: testSchema,
    database: { dbFilename, vfs: BENCH_VFS, additionalReaders: BENCH_READERS },
    ...(plugin ? { plugins: [plugin] } : {})
  });
  return { db, plugin };
}

async function databaseSize(db: PowerSyncDatabase): Promise<number> {
  const row = await db.get<{ size: number }>(
    'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()'
  );
  return row.size;
}

async function seedToSize(db: PowerSyncDatabase, targetBytes: number) {
  let seq =
    (await db.get<{ m: number | null }>("SELECT MAX(json_extract(data, '$.seq')) AS m FROM ps_data__items")).m ?? 0;
  while ((await databaseSize(db)) < targetBytes) {
    await db.execute(
      `INSERT INTO ps_data__items(id, data)
       SELECT uuid(), json_object('seq', n, 'payload', hex(randomblob(512)))
       FROM (WITH RECURSIVE cnt(n) AS (SELECT ?1 UNION ALL SELECT n + 1 FROM cnt WHERE n < ?1 + ?2 - 1) SELECT n FROM cnt)`,
      [seq + 1, BATCH_ROWS]
    );
    seq += BATCH_ROWS;
  }
}

/** Phase A: the adapter alone, with no PowerSyncDatabase wrapped around it. */
async function measureAdapterOpen(filename: string) {
  const logger = createConsoleLogger({ minLevel: LogLevels.warn });
  const t0 = performance.now();
  const factory = new WASQLiteOpenFactory({
    open: { dbFilename: filename, vfs: BENCH_VFS, additionalReaders: BENCH_READERS },
    logger
  });
  const adapter = factory.openDB();
  const tConstructed = performance.now();
  await adapter.execute('SELECT 1');
  const tReady = performance.now();
  await adapter.close();
  return {
    constructMs: tConstructed - t0,
    toFirstStatementMs: tReady - t0,
    resources: resourcePhases(t0)
  };
}

interface ColdStartResult {
  vfs: string;
  additionalReaders: number;
  cpuThrottle: number;
  sizeMb: number;
  actualBytes: number;
  rows: number;
  adapterColdOpenMs: number;
  adapterColdConstructMs: number;
  adapterColdResources: ResourcePhase[];
  adapterWarmOpenMs: number;
  powerSyncInitMs: number;
  powerSyncInitOverheadMs: number;
  firstQueryMs: number;
  cacheReadMs: number;
}

describe('cold start breakdown', () => {
  it('attributes the pre-render cost to a phase', { timeout: 1_800_000 }, async () => {
    // Phase A, on a page where nothing has loaded the module yet. This must be the very
    // first database touched in the run, or the fetch and compile costs are already paid
    // and the numbers describe a warm page instead of a refresh.
    const cold = await measureAdapterOpen(`cold-${dbFilename}`);

    // The same open again, module now warm: the difference is what fetching and
    // compiling the module costs versus merely starting a worker and opening a file.
    const warm = await measureAdapterOpen(`warm-${dbFilename}`);

    // Phase B: what PowerSync adds on top of an open adapter, measured warm so the
    // module cost does not land in this bucket too.
    const tInit = performance.now();
    const { db: initDb } = openDatabase(false);
    await initDb.init();
    const powerSyncInitMs = performance.now() - tInit;

    await seedToSize(initDb, SIZE_MB * 1024 * 1024);
    const actualBytes = await databaseSize(initDb);
    const rows = (await initDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM ps_data__items')).n;
    await initDb.close();

    // Populate the cache so phase D has something to read.
    const { db: warmDb, plugin } = openDatabase(true);
    const warmWatch = warmDb.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
    await new Promise<void>((resolve) => {
      const check = (state: { source: string; data: unknown[] }) => {
        if (state.source === 'live' && state.data?.length) resolve();
      };
      check(warmWatch.state as any);
      warmWatch.registerListener({ onStateChange: check as any });
    });
    await new Promise((r) => setTimeout(r, 100));
    await plugin!.flush();
    await warmWatch.close();
    await warmDb.close();

    if (BENCH_CPU_THROTTLE !== 1) {
      await (commands as any).setCpuThrottling(BENCH_CPU_THROTTLE);
    }

    // Phase C: a ready database to rows on screen.
    const { db: queryDb } = openDatabase(false);
    await queryDb.init();
    const tQuery = performance.now();
    const watched = queryDb.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
    await new Promise<void>((resolve) => {
      const check = (state: { data: unknown[] }) => {
        if (state.data?.length) resolve();
      };
      check(watched.state as any);
      watched.registerListener({ onStateChange: check as any });
    });
    const firstQueryMs = performance.now() - tQuery;
    await watched.close();
    await queryDb.close();

    // Phase D: the cached paint, from construction, on the same page.
    const tCache = performance.now();
    const { db: cachedDb } = openDatabase(true);
    const cachedWatch = cachedDb.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
    await new Promise<void>((resolve) => {
      const check = (state: { source: string; data: unknown[] }) => {
        if (state.source === 'cache' && state.data?.length) resolve();
      };
      check(cachedWatch.state as any);
      cachedWatch.registerListener({ onStateChange: check as any });
    });
    const cacheReadMs = performance.now() - tCache;
    await cachedWatch.close();
    await cachedDb.close();

    if (BENCH_CPU_THROTTLE !== 1) {
      await (commands as any).setCpuThrottling(1);
    }

    const result: ColdStartResult = {
      vfs: BENCH_VFS,
      additionalReaders: BENCH_READERS,
      cpuThrottle: BENCH_CPU_THROTTLE,
      sizeMb: SIZE_MB,
      actualBytes,
      rows,
      adapterColdOpenMs: cold.toFirstStatementMs,
      adapterColdConstructMs: cold.constructMs,
      adapterColdResources: cold.resources,
      adapterWarmOpenMs: warm.toFirstStatementMs,
      powerSyncInitMs,
      // What PowerSync's own initialize() costs beyond having an open adapter.
      powerSyncInitOverheadMs: powerSyncInitMs - warm.toFirstStatementMs,
      firstQueryMs,
      cacheReadMs
    };

    console.log(`COLDSTART_RESULT ${JSON.stringify(result)}`);
    await (commands as any).saveColdStartResults(
      JSON.stringify({ generatedAt: new Date().toISOString(), result }, null, 2)
    );

    expect(firstQueryMs).toBeGreaterThan(0);
    expect(cacheReadMs).toBeGreaterThan(0);
  });
});
