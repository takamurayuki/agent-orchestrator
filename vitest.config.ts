import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/runner/test/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/desktop/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'json'] : ['default'],
    outputFile: { json: 'test-results/vitest.json' }
  }
});
