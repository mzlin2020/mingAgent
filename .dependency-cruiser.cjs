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
      name: 'storage-不得依赖-electron',
      comment:
        '存储适配器要能在 headless 与 CLI 下使用（ADR-0013 / ADR-0016）。原生模块的 ABI 差异' +
        '由构建期的 electron-rebuild 处理，不是靠在代码里 import electron 解决。',
      severity: 'error',
      from: { path: '^packages/storage/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'providers-零-node内置',
      comment:
        'Provider 适配器只用 Web 平台 API（fetch / AbortController / TextDecoder）。' +
        '这不是洁癖：包里读不到 node:process，密钥就**只能**来自调用方传进来的 apiKey，' +
        '而那个值只能出自 SecretStore。一个"顺手"的 process.env.ANTHROPIC_API_KEY ' +
        '会在这条规则下直接失败。顺带保住了跑在浏览器/Worker 里那条退路。',
      severity: 'error',
      from: { path: '^packages/providers/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'providers-不得依赖-electron',
      severity: 'error',
      from: { path: '^packages/providers/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'tools-core-零-node内置',
      comment:
        '业务工具只能经 ToolContext.executor 使用文件、进程与 PTY；直接 import node:* 会绕过' +
        '整个执行世界接缝，使容器/远端 provider 失去约束力（ADR-0054 / ADR-0063）。',
      severity: 'error',
      from: { path: '^packages/tools-core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'tools-core-不得依赖-electron',
      comment:
        '基础工具集要能在 CLI 与 headless 冒烟下使用，也要能在换掉执行后端时原样复用。',
      severity: 'error',
      from: { path: '^packages/tools-core/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'tools-core-不得依赖-runtime',
      comment:
        '依赖方向：runtime 装配工具，工具不认识装配层。反过来就会出现"工具直接往事件流里写"' +
        '——而 ToolContext 里没有记录事件的入口是刻意的（ADR-0019：工具在结构上发不出 trust.cleared）。',
      severity: 'error',
      from: { path: '^packages/tools-core/src' },
      to: { path: '^packages/(runtime|storage|platform)/src' },
    },
    {
      name: 'tools-core-不得依赖-tool-runtime',
      comment: '业务工具只能经注入端口取得安全底座，不得直连 provider（ADR-0063）。',
      severity: 'error',
      from: { path: '^packages/tools-core/src' },
      to: { path: '^packages/tool-runtime/src' },
    },
    {
      name: 'tool-runtime-不得依赖-electron',
      comment: '执行网关与 checkpoint 必须同时服务 desktop、CLI 与 headless（ADR-0063）。',
      severity: 'error',
      from: { path: '^packages/tool-runtime/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'compose-不得依赖-electron',
      comment: 'profile 解析与容器装配是所有入口共享的纯装配层（ADR-0059）。',
      severity: 'error',
      from: { path: '^packages/compose/src' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: '只有-apps-可以依赖-compose',
      comment: 'compose 是应用入口的组合根，不得反向渗入业务包。',
      severity: 'error',
      from: { path: '^packages/(?!compose/)[^/]+/src' },
      to: { path: '^packages/compose/src' },
    },
    {
      name: '内核与装配层不得依赖-tools-core',
      comment:
        '原则二（docs/01）："删掉 packages/tools-core 后，内核 + UI 必须仍能启动（只是没有' +
        '工具可用）"——这条验收约束此前只写在文档里，从没在依赖图上验证过（ADR-0032 #6）。' +
        'kernel/runtime/storage/platform 反过来认识 tools-core，这条约束就直接是假的：装配层' +
        '会因为少了一个具体工具包而编译不过，而不是"没有工具可用但照常启动"。' +
        '真正暴露的耦合是 apps/desktop/src/main/desktop-host.ts（桌面 surface 的宿主桥，' +
        '见 packages/runtime/tests/tools-core-independence.test.ts 的说明），这条规则先把' +
        '"内核层"这一半锁死，不留退路。',
      severity: 'error',
      from: { path: '^packages/(kernel|runtime|storage|platform)/src' },
      to: { path: '^packages/tools-core/src' },
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
      name: '渲染层禁-node-与-electron',
      comment:
        'contextIsolation / nodeIntegration:false 的承诺在依赖图上的形态（ADR-0015）。' +
        '渲染层拿不到 Node，也不该直接碰 electron——它与主进程之间只有 preload 那四个具名调用。' +
        '这条与 tsconfig.renderer.json 的 `types: []` 是同一件事的两道锁：' +
        '类型那道防的是写代码时，这道防的是"从某个第三方库间接引进来"。',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: '渲染层不得直接依赖-electron',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer' },
      to: { path: 'node_modules/electron' },
    },
    {
      name: 'preload-必须保持薄',
      comment:
        'preload 是 contextIsolation 唯一的缺口，缺口的大小等于它的表面积（ADR-0015）。' +
        '只许依赖 electron 与 shared/channels.ts（纯常量）——不许 zod、不许 @xm/*、' +
        '不许存储。一个"顺手"在这里做的转换，就是页面能间接影响主进程状态的地方。',
      severity: 'error',
      from: { path: '^apps/desktop/src/preload' },
      to: {
        pathNot: ['^apps/desktop/src/preload', '^apps/desktop/src/shared/channels', 'node_modules/electron'],
      },
    },
    {
      name: 'packages-不得依赖-apps',
      comment: '分层方向：apps 是装配的终点，不是任何人的依赖。',
      severity: 'error',
      from: { path: '^packages/[^/]+/src' },
      to: { path: '^apps/' },
    },
    {
      name: '禁止无法解析的依赖',
      comment:
        '2026-08-05 的反向演练发现的洞：在 kernel/runtime 里写 `import "electron"`，' +
        'depcruise 全绿。原因是 electron 当时还没装，import 解析不到，那条边压根不进依赖图——' +
        '于是四条"不得依赖 electron"的规则**只在 electron 已安装时才生效**，' +
        '而最该拦的恰恰是"某个包偷偷 import 了自己没声明的依赖"这种情况。\n' +
        '这与 ADR-0011 ⑨ 的 includeOnly 是同一类失效：规则在、输出全绿、实际没管住。\n' +
        '本条兜底：解析不到就是错，不管是打错字还是引了未声明的包。',
      severity: 'error',
      from: { path: '^(packages|apps)/[^/]+/src' },
      to: { couldNotResolve: true },
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
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '(^|/)tests?/', '\\.test\\.ts$', '\\.config\\.ts$'],
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
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'],
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
