/**
 * 架构守护（docs/04 §9、docs/10 铁律 1、ADR-0001）。
 *
 * 这里只管**依赖图**层面的约束。看不到标识符的约束（如禁止 process.platform）
 * 由 ESLint 执行，见 eslint.config.js。
 */
module.exports = {
  forbidden: [
    {
      name: 'contracts-只能依赖-zod',
      comment:
        '契约包是唯一的事实来源，必须能在浏览器里 import。依赖只允许 zod（docs/10 铁律 1）。',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: {
        pathNot: ['^packages/contracts/src', 'node_modules/zod'],
      },
    },
    {
      name: 'contracts-不得依赖其它-xm-包',
      comment: '契约在依赖图的最底层，它依赖别人就说明分层反了（docs/10 铁律 1）。',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^packages/(?!contracts)' },
    },
    {
      name: 'kernel-零-IO',
      comment:
        '内核必须能在浏览器/测试里跑，禁止任何 node 内置模块（docs/01 原则二、docs/04 §9）。',
      severity: 'error',
      from: { path: '^packages/kernel/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'kernel-不得依赖-electron',
      comment: '换外壳的退路靠这条维持（ADR-0001）。',
      severity: 'error',
      from: { path: '^packages/kernel/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'platform-不得依赖-electron',
      comment:
        'PlatformPort 的 Node 实现要能被 CLI 与 headless 冒烟使用（ADR-0007 / ADR-0014）。' +
        '外壳特有的能力（safeStorage / 托盘 / 通知）由 apps/desktop 用 withCapabilities 往上抬。',
      severity: 'error',
      from: { path: '^packages/platform/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'runtime-不得依赖-electron',
      comment:
        'CLI 形态延后到 M3，但架构约束从 M0 起生效（ADR-0007 / docs/09 A2）。runtime 泄漏 electron 依赖，CLI 就永远起不来。',
      severity: 'error',
      from: { path: '^packages/runtime/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: '禁止循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: '禁止孤儿模块',
      comment: '没人引用的文件多半是重构残留。测试文件与包入口天然无人引用，排除。',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '(^|/)tests?/', '\\.test\\.ts$'],
      },
      to: {},
    },
    {
      name: '生产代码不得依赖测试',
      severity: 'error',
      from: { path: '^packages/[^/]+/src' },
      to: { path: '(^|/)tests?/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // 只看源码。dist 是产物，扫它只会产生噪音（每个 .js 都是孤儿）。
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mts', '.mjs'],
    },
    // ⚠️ 这里刻意**不设** includeOnly。
    // 曾经写过 includeOnly: '^(packages|apps)/'，结果是 node 核心模块与 node_modules
    // 里的依赖压根不进依赖图——于是"内核禁 node:*"和"契约只许依赖 zod"这两条规则
    // 全部静默失效，depcruise 照样报 no violations。
    // 2026-08-04 的违规演练抓到了这个洞：加一行 `import 'node:fs'` 到 kernel 里，
    // depcruise 依然全绿。规则存在 ≠ 规则生效，必须靠故意违规来验。
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
