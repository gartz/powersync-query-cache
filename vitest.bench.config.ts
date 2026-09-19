import path from 'node:path';
import { writeFileSync } from 'node:fs';
import baseConfig from './vitest.browser.config.js';

// Cold-boot benchmark suite. Kept out of the regular browser run: it seeds hundreds of
// megabytes into IndexedDB and takes minutes, which is measurement, not verification.
// Built by spreading (not mergeConfig) so `include` replaces the base list instead of
// concatenating with it.
const base = baseConfig as any;

export default {
  ...base,
  test: {
    ...base.test,
    include: ['tests/benchmark/**/*.test.ts'],
    // 200MB on OPFS WAL exceeded ten minutes; the ceiling has to be high enough that a
    // slow result is a measurement rather than a timeout.
    testTimeout: 1_800_000,
    // One sequential file; timings must not share the browser with parallel work.
    fileParallelism: false,
    browser: {
      ...base.test.browser,
      commands: {
        // Browser console output is not reliably forwarded by the reporter, so the
        // suite ships its measurements to the server side explicitly.
        /**
         * Chrome DevTools CPU throttling, applied to the whole page (workers included).
         * A rate of 4 approximates a mid-range phone and 6 an older one relative to this
         * host — the point being that the cost here is not linear in device speed, which
         * is exactly what a desktop-only benchmark hides.
         */
        setCpuThrottling: async (ctx: any, rate: number) => {
          const session = await ctx.context.newCDPSession(ctx.page);
          await session.send('Emulation.setCPUThrottlingRate', { rate });
          await session.detach();
        },
        saveColdStartResults: (_ctx: unknown, json: string) => {
          const vfs = process.env.VITE_BENCH_VFS ?? 'IDBBatchAtomicVFS';
          const readers = process.env.VITE_BENCH_READERS ?? '1';
          const cpu = process.env.VITE_BENCH_CPU_THROTTLE ?? '1';
          writeFileSync(path.resolve(`tests/benchmark/coldstart-${vfs}-${readers}r-${cpu}x.json`), json + '\n');
        },
        saveBenchResults: (_ctx: unknown, json: string) => {
          // One file per VFS, so an OPFS run does not overwrite the IndexedDB baseline.
          const vfs = process.env.VITE_BENCH_VFS ?? 'IDBBatchAtomicVFS';
          const readers = process.env.VITE_BENCH_READERS ?? '1';
          const cpu = process.env.VITE_BENCH_CPU_THROTTLE ?? '1';
          writeFileSync(path.resolve(`tests/benchmark/latest-results-${vfs}-${readers}r-${cpu}x.json`), json + '\n');
          writeFileSync(path.resolve('tests/benchmark/latest-results.json'), json + '\n');
        }
      }
    }
  }
};
