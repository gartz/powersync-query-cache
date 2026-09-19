import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// The PowerSync SDK is consumed through `file:` dependencies pointing at a local
// checkout (see README "Development"). Where that checkout lives is a property of the
// machine, not of this repository, so it comes from the environment with the fleet's
// conventional location as the default.
const projectRoot = process.cwd();
const powerSyncSdkPath = path.resolve(process.env.POWERSYNC_SDK_PATH ?? '/powersync-js');

export default defineConfig({
  // @powersync/web loads its sync worker via a Web Worker URL and wa-sqlite via wasm;
  // these mirror the SDK's own browser test config (packages/web/vitest.config.ts).
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    fs: {
      // @powersync/web is linked in via a `file:` dependency (a symlink into the SDK
      // checkout), which resolves outside this project's root — Vite's default
      // fs.allow only covers the workspace root, so its worker asset
      // (packages/web/lib/worker/worker.js) and its wa-sqlite wasm dependency
      // (resolved from the monorepo's pnpm store under the checkout's node_modules)
      // get 403'd unless the whole checkout is allow-listed.
      allow: [projectRoot, powerSyncSdkPath]
    }
  },
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite']
  },
  test: {
    globals: true,
    include: ['tests/idb/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    testTimeout: 30000,
    browser: {
      enabled: true,
      // The nest has no system Chromium and Playwright's downloaded build cannot resolve
      // its shared libraries here, so the browser comes from the environment when
      // CHROMIUM_EXECUTABLE_PATH is set (see README "Development").
      provider: playwright({
        launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
          : {}
      }),
      headless: true,
      instances: [{ browser: 'chromium' }]
    }
  }
});
