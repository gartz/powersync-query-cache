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
    testTimeout: 600_000,
    // One sequential file; timings must not share the browser with parallel work.
    fileParallelism: false,
    browser: {
      ...base.test.browser,
      commands: {
        // Browser console output is not reliably forwarded by the reporter, so the
        // suite ships its measurements to the server side explicitly.
        saveBenchResults: (_ctx: unknown, json: string) => {
          writeFileSync(path.resolve('tests/benchmark/latest-results.json'), json + '\n');
        }
      }
    }
  }
};
