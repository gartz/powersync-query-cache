import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  // @powersync/web loads its sync worker via a Web Worker URL and wa-sqlite via wasm;
  // these mirror the SDK's own browser test config (packages/web/vitest.config.ts).
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    fs: {
      // @powersync/web is linked in via a `file:` dependency (a symlink into
      // /powersync-js/packages/web), which resolves outside this project's root —
      // Vite's default fs.allow only covers the workspace root, so its worker asset
      // (packages/web/lib/worker/worker.js) and its wa-sqlite wasm dependency
      // (resolved from the monorepo's pnpm store under /powersync-js/node_modules)
      // get 403'd unless the whole fork checkout is allow-listed.
      allow: ['/home/coder/powersync-query-cache', '/powersync-js']
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
    browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] }
  }
});
