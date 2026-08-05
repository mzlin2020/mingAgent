import { defineConfig } from 'tsup';

/**
 * 主进程与 preload 的打包（docs/03 §4 选定的 tsup）。
 *
 * 两个产物的格式**刻意不同**：
 *
 *   · main    ESM。`package.json` 是 `type: module`，`.js` 即 ESM，
 *             Electron 28+ 的主进程支持 ESM。
 *   · preload **CJS，且扩展名必须是 `.cjs`**。`sandbox: true` 的 preload 只能是 CJS，
 *             而 `type: module` 下的 `.js` 会被当成 ESM 加载并直接失败。
 *             这个坑的表现是"窗口空白、控制台里一句 `require is not defined`"，
 *             与业务代码毫无关系，所以在这里写清楚。
 *
 * externals 只有两个：`electron` 由运行时提供，`better-sqlite3` 是原生模块
 * （`.node` 二进制打不进 bundle，且 ABI 要由 electron-rebuild 对齐，ADR-0016）。
 * `@xm/*` 全部打进产物——它们是 workspace 包，不会被单独发布。
 */
export default defineConfig([
  {
    entry: { index: 'src/main/index.ts' },
    outDir: 'dist/main',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    external: ['electron', 'better-sqlite3'],
    sourcemap: true,
    clean: true,
    // 类型检查归 `tsc -b`（ADR-0010：编译走 TS 7 原生）。这里只转译，不重复一遍
    dts: false,
  },
  {
    entry: { index: 'src/preload/index.ts' },
    outDir: 'dist/preload',
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
    dts: false,
  },
]);
