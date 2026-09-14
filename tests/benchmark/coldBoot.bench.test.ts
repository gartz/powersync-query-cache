import { commands } from '@vitest/browser/context';
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';
import { describe, expect, it } from 'vitest';
import { QueryCachePlugin } from '../../src/index.js';
import { IndexedDbQueryCacheStorage } from '../../src/idb/index.js';

/**
 * Cold-boot benchmark: how long until a watched query has rows on screen, with and
 * without the cache, as the SQLite database grows.
 *
 * Method:
 * - One database file, grown cumulatively through the target sizes (10 → 50 → 100 →
 *   200 MB) by inserting ~1KB rows directly into the internal `ps_data__items` table —
 *   the same shape synced data has, without inflating the upload queue the way view
 *   inserts would.
 * - "Cold boot" = a brand-new PowerSyncDatabase instance on the same file. wa-sqlite's
 *   page cache is per-connection, so every boot re-reads pages from IndexedDB. (A full
 *   page reload is not available inside the test runner; this is the closest proxy.)
 * - The watched query is dashboard-shaped: ORDER BY over a non-indexed extracted column
 *   with a LIMIT, so the live query genuinely scales with table size.
 * - Per size: one warm boot populates the cache (and flushes it), then ITERATIONS
 *   measured boots per mode. Reported numbers are medians.
 *
 * Timings per boot, all relative to the `new PowerSyncDatabase(...)` call:
 * - tCache: first state emission with source 'cache' (rows painted from IndexedDB)
 * - tLive:  first state emission with source 'live' and data (rows from SQLite)
 */

const testSchema = new Schema({
  items: new Table({ seq: column.integer, payload: column.text })
});

const BENCH_QUERY = 'SELECT id, seq, substr(payload, 1, 64) AS preview FROM items ORDER BY seq DESC LIMIT 50';
const SIZES_MB = [10, 50, 100, 200];
const ITERATIONS = 3;
const BATCH_ROWS = 2000; // ~2MB per insert statement

const dbFilename = `bench-${crypto.randomUUID()}.db`;
const cacheDatabaseName = `bench-cache-${crypto.randomUUID()}`;

interface BootTimings {
  tCache?: number;
  tLive: number;
}

interface SizeResult {
  sizeMb: number;
  actualBytes: number;
  rows: number;
  liveNoCacheMs: number;
  cachePaintMs: number;
  liveWithCacheMs: number;
  navNoCacheMs: number;
  navCacheMs: number;
}

const results: SizeResult[] = [];

function openDatabase(withCache: boolean): { db: PowerSyncDatabase; plugin?: QueryCachePlugin } {
  const plugin = withCache
    ? new QueryCachePlugin({
        storage: new IndexedDbQueryCacheStorage({ databaseName: cacheDatabaseName }),
        debounceMs: 10
      })
    : undefined;
  const db = new PowerSyncDatabase({
    schema: testSchema,
    database: { dbFilename },
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

async function rowCount(db: PowerSyncDatabase): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ps_data__items');
  return row.n;
}

/** Grows the database to at least targetBytes with ~1KB rows of synced-shaped data. */
async function seedToSize(db: PowerSyncDatabase, targetBytes: number) {
  let seq = (await db.get<{ m: number | null }>("SELECT MAX(json_extract(data, '$.seq')) AS m FROM ps_data__items")).m ?? 0;
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

async function measureBoot(withCache: boolean): Promise<BootTimings> {
  const t0 = performance.now();
  const { db } = openDatabase(withCache);
  const watched = db.query<{ id: string }>({ sql: BENCH_QUERY }).watch();

  const timings: BootTimings = { tLive: NaN };
  await new Promise<void>((resolve) => {
    const record = (state: { source: string; data: unknown[] }) => {
      if (state.source === 'cache' && timings.tCache === undefined) {
        timings.tCache = performance.now() - t0;
      }
      if (state.source === 'live' && state.data?.length && Number.isNaN(timings.tLive)) {
        timings.tLive = performance.now() - t0;
        resolve();
      }
    };
    record(watched.state as any);
    watched.registerListener({ onStateChange: record as any });
  });

  await watched.close();
  await db.close();
  return timings;
}

/**
 * In-session navigation: the database instance stays open (the page was not reloaded);
 * the watched query is torn down and re-created, as a router does on back/forward.
 * With the cache, the memory layer seeds the CONSTRUCTED state synchronously, so the
 * time to first rows is just the watch() call itself. Without it, the live query
 * re-runs from scratch. Warm-up watch first in both modes so SQLite's per-connection
 * page cache is equally warm — the difference measured is the render path, not disk.
 */
async function measureNav(withCache: boolean): Promise<number> {
  const { db } = openDatabase(withCache);

  const warm = db.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
  await new Promise<void>((resolve) => {
    const check = (state: { source: string; data: unknown[] }) => {
      if (state.source === 'live' && state.data?.length) resolve();
    };
    check(warm.state as any);
    warm.registerListener({ onStateChange: check as any });
  });
  await warm.close();

  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const watched = db.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
    if (withCache) {
      // The memory layer must have painted synchronously, in the constructed state —
      // anything async here would be the IDB or live path, not the nav path.
      expect(watched.state.source).toBe('cache');
      expect(watched.state.data.length).toBeGreaterThan(0);
      times.push(performance.now() - t0);
    } else {
      await new Promise<void>((resolve) => {
        const check = (state: { data: unknown[] }) => {
          if (state.data?.length) {
            times.push(performance.now() - t0);
            resolve();
          }
        };
        check(watched.state as any);
        watched.registerListener({ onStateChange: check as any });
      });
    }
    await watched.close();
  }

  await db.close();
  return median(times);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('cold boot benchmark', () => {
  for (const sizeMb of SIZES_MB) {
    it(`measures cold boot at ${sizeMb}MB`, { timeout: 600_000 }, async () => {
        // Grow the shared database file to this stage's size.
        const { db: seeder } = openDatabase(false);
        await seeder.init();
        await seedToSize(seeder, sizeMb * 1024 * 1024);
        const actualBytes = await databaseSize(seeder);
        const rows = await rowCount(seeder);
        await seeder.close();

        // Warm boot: runs the live query once and persists it to the cache.
        const { db: warmDb, plugin } = openDatabase(true);
        const warmWatch = warmDb.query<{ id: string }>({ sql: BENCH_QUERY }).watch();
        await new Promise<void>((resolve) => {
          const check = (state: { source: string; data: unknown[] }) => {
            if (state.source === 'live' && state.data?.length) resolve();
          };
          check(warmWatch.state as any);
          warmWatch.registerListener({ onStateChange: check as any });
        });
        // Let the debounced write land before closing.
        await new Promise((r) => setTimeout(r, 100));
        await plugin!.flush();
        await warmWatch.close();
        await warmDb.close();

        const noCache: BootTimings[] = [];
        const withCache: BootTimings[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          noCache.push(await measureBoot(false));
          withCache.push(await measureBoot(true));
        }

        const navNoCacheMs = await measureNav(false);
        const navCacheMs = await measureNav(true);

        const cachePaints = withCache.map((t) => t.tCache);
        expect(cachePaints.every((t): t is number => typeof t === 'number')).toBe(true);

        const result: SizeResult = {
          sizeMb,
          actualBytes,
          rows,
          liveNoCacheMs: median(noCache.map((t) => t.tLive)),
          cachePaintMs: median(cachePaints as number[]),
          liveWithCacheMs: median(withCache.map((t) => t.tLive)),
          navNoCacheMs,
          navCacheMs
        };
        results.push(result);
        console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
        console.log(
          `BENCH ${sizeMb}MB (actual ${(actualBytes / 1024 / 1024).toFixed(1)}MB, ${rows} rows): ` +
            `no-cache first rows ${result.liveNoCacheMs.toFixed(0)}ms | ` +
            `cache paint ${result.cachePaintMs.toFixed(0)}ms | ` +
            `live swap (cached boot) ${result.liveWithCacheMs.toFixed(0)}ms | ` +
            `nav no-cache ${result.navNoCacheMs.toFixed(0)}ms | nav cache ${result.navCacheMs.toFixed(2)}ms`
        );
    });
  }

  it('prints the summary table', async () => {
    const lines = [
      'BENCH_SUMMARY',
      '| DB size | Cold boot no cache | Cold boot cached | Nav no cache | Nav cached |',
      '| --- | --- | --- | --- | --- |',
      ...results.map((r) => {
        return `| ${r.sizeMb}MB | ${r.liveNoCacheMs.toFixed(0)}ms | ${r.cachePaintMs.toFixed(0)}ms | ${r.navNoCacheMs.toFixed(0)}ms | ${r.navCacheMs.toFixed(2)}ms |`;
      })
    ];
    console.log(lines.join('\n'));
    expect(results).toHaveLength(SIZES_MB.length);
    // The reporter does not forward browser console output, so persist the numbers
    // where the host can read them: tests/benchmark/latest-results.json.
    await (commands as any).saveBenchResults(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  });
});
