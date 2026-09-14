import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Browser-only suites: IndexedDB storage, SDK e2e, and the cold-boot benchmark.
    exclude: ['tests/idb/**', 'tests/e2e/**', 'tests/benchmark/**', '**/node_modules/**']
  }
});
