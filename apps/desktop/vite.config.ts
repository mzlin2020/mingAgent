import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 渲染层的构建。
 *
 * `base: './'` 是必须的：打包后主进程用 `file://` 加载 index.html，绝对路径会 404。
 * 这类问题在 `pnpm dev` 下永远不出现（那时走的是 http），只在打包产物里炸——
 * 所以 b4 的验收里有一条"跑打包出来的应用"，而不只是"dev 起得来"。
 *
 * 别名指向各包的 `src`，与 `vitest.config.ts` 保持一致：改一行不用先 build。
 * 这也意味着 Vite 会用 esbuild 转译我们的 TS——**它不做类型检查**，
 * 类型检查仍然只由 `tsc -b` 负责，双编译器纪律（ADR-0010）不受影响。
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@xm/contracts': pkg('contracts'),
      '@xm/kernel': pkg('kernel'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    // 渲染层进不了 Node，构建目标按 Electron 内置的 Chromium 定
    target: 'chrome132',
    sourcemap: true,
  },
  server: { port: 5273, strictPort: true },
});
