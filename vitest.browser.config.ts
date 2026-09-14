import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/idb/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] }
  }
});
