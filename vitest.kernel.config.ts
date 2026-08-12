import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/kernel/tests/**/*.test.ts', 'packages/runtime/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['packages/kernel/src/**/*.ts'],
      exclude: ['**/index.ts'],
      thresholds: { lines: 85 },
    },
  },
  resolve: {
    alias: {
      '@xm/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@xm/kernel': fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url)),
      '@xm/platform': fileURLToPath(new URL('./packages/platform/src/index.ts', import.meta.url)),
      '@xm/providers': fileURLToPath(new URL('./packages/providers/src/index.ts', import.meta.url)),
      '@xm/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@xm/tools-core': fileURLToPath(new URL('./packages/tools-core/src/index.ts', import.meta.url)),
      '@xm/runtime': fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
    },
  },
});
