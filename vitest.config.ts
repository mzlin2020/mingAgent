import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 单一根配置：包数还少时，一个 vitest 进程比每包一份配置更快也更好懂。
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    // 内核与契约都是纯函数，测试不该有任何 I/O，超时给短一点，卡住立刻暴露
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts'],
    },
  },
  resolve: {
    alias: {
      // 让测试直接吃源码，省掉"改一行要先 build"的循环
      '@xm/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@xm/kernel': fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url)),
      '@xm/platform': fileURLToPath(new URL('./packages/platform/src/index.ts', import.meta.url)),
    },
  },
});
