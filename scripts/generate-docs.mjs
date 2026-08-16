#!/usr/bin/env node
/**
 * 从代码生成四张自省表（ADR-0060 §二），落在 `docs/generated/`。
 *
 * 第五张（profile 接缝图）在 `generate-seam-map.mjs`，M3-b 就有了。
 *
 * ── 为什么这些表必须生成而不是手写 ──
 *
 * 「文档与代码同批提交」是一条纪律，而纪律靠人记得。这四张表恰好是最容易漂、
 * 也最有价值的那几张：事件谁发谁听、扩展点上挂了谁、工具有哪些能力、配置有哪些字段。
 * 生成之后它们由闸门盯着，漂一个字就红。
 *
 * ── 扩展点挂载表为什么要真的装配一次 ──
 *
 * 容器化把一部分依赖关系从 import 图挪到了运行时（ADR-0052 的真损失）。
 * 静态分析看得见 `installStoppingGuard(host)` 这一行，看不见它最终挂在哪个点上、排第几——
 * 而"这次调用经过了什么"问的正是后者。所以这里用**桩服务**真装一次 `test` profile，
 * 再问容器 `mounts()`。桩只替代 I/O，插件行与顺序是真的。
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_SPECS, redact } from '../packages/contracts/dist/index.js';
import { Config } from '../packages/contracts/dist/index.js';
import {
  MemoryEventStore,
  ToolRegistry,
  pureGateway,
} from '../packages/kernel/dist/index.js';
import { assembleProfile, builtinProfile } from '../packages/compose/dist/index.js';
import {
  EventBus,
  SessionRuntime,
  createInvariantRegistry,
  createTurnExtensionHost,
  installCheckpoint,
  installContextBuilder,
  installMultimodalGuard,
  installResultTruncation,
  installStoppingGuard,
  resultExpandTool,
  subagentExploreTool,
  todoUpdateTool,
} from '../packages/runtime/dist/index.js';
import { localExecutionWorld } from '../packages/tool-runtime/dist/index.js';
import {
  coreTools,
  editApplyTool,
  editPreviewTool,
  shellSessionTools,
} from '../packages/tools-core/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs/generated');
const HEADER = (title) =>
  `# ${title}\n\n> 本文件由 \`node scripts/generate-docs.mjs\` 生成；请勿手工编辑。\n\n`;

// ── 一、事件生产消费表 ────────────────────────────────────────────

const SCAN_ROOTS = ['packages', 'apps/desktop/src'];
const SKIP = new Set(['dist', 'node_modules', 'tests', 'release', 'coverage']);

const sourceFiles = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(ROOT, root));
  return files.sort();
};

const eventTable = () => {
  const files = sourceFiles().map((path) => ({
    rel: relative(ROOT, path).replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  }));
  // 契约包自己是**定义**事件的地方，不算生产者也不算消费者
  const code = files.filter((file) => !file.rel.startsWith('packages/contracts/'));

  const rows = [];
  for (const [type, spec] of Object.entries(EVENT_SPECS)) {
    const quoted = `'${type}'`;
    const producers = code
      .filter((file) => file.text.includes(`type: ${quoted}`))
      .map((file) => file.rel);
    const consumers = code
      .filter(
        (file) =>
          file.text.includes(`case ${quoted}`) ||
          file.text.includes(`=== ${quoted}`) ||
          file.text.includes(`!== ${quoted}`) ||
          file.text.includes(`[${quoted}`) ||
          file.text.includes(`${quoted},`),
      )
      .map((file) => file.rel)
      .filter((rel) => !producers.includes(rel));
    rows.push({ type, durability: spec.durability, version: spec.version, producers, consumers });
  }

  const cell = (list) =>
    list.length === 0 ? '—' : list.map((item) => `\`${item}\``).join('<br>');
  return (
    HEADER('事件生产消费表') +
    '每个事件类型由谁写、被谁读。**生产者**是出现 `type: \'…\'` 的文件，' +
    '**消费者**是按类型分支或按类型过滤的文件（`case` / `===` / 类型清单）。\n\n' +
    '一个持久事件没有生产者，通常意味着一条"契约完整、零产出"的死路——' +
    '`DisplayHint` 与 `checkpoint.created` 都在这张表上原形毕露过。\n\n' +
    '| 事件 | 层级 | 版本 | 生产者 | 消费者 |\n|---|---|---|---|---|\n' +
    rows
      .map(
        (row) =>
          `| \`${row.type}\` | ${row.durability} | v${String(row.version)} | ` +
          `${cell(row.producers)} | ${cell(row.consumers)} |`,
      )
      .join('\n') +
    '\n'
  );
};

// ── 二、扩展点挂载表 ──────────────────────────────────────────────

const stubCatalog = () => {
  const plugin = (row, apply) => ({
    name: row.id,
    inject: row.inject,
    provide: row.provide,
    apply,
  });
  const noop = () => undefined;
  return {
    '@xm/kernel#deterministicClock': (row) =>
      plugin(row, (ctx) => ctx.provide('clock', { now: () => 0 })),
    '@xm/kernel#deterministicIds': (row) =>
      plugin(row, (ctx) => ctx.provide('ids', { session: () => 's', event: () => 'e' })),
    '@xm/runtime#invariants': (row) =>
      plugin(row, (ctx) => {
        const { registry, dispose } = createInvariantRegistry();
        ctx.provide('invariants', registry);
        return dispose;
      }),
    '@xm/runtime#turnDriver': (row) =>
      plugin(row, (ctx) => ctx.provide('turnExtensions', createTurnExtensionHost(ctx))),
    '@xm/kernel#policy': (row) => plugin(row, (ctx) => ctx.provide('policy', [])),
    '@xm/tool-runtime#gateway': (row) =>
      plugin(row, (ctx) => ctx.provide('gateway', pureGateway((name) => name))),
    '@xm/tool-runtime#localExecutor': (row) =>
      plugin(row, (ctx) => ctx.provide('executor', localExecutionWorld)),
    '@xm/tool-runtime#checkpoint': (row) =>
      plugin(row, (ctx) => {
        ctx.provide('checkpointer', { before: () => Promise.resolve(undefined) });
        ctx.provide('checkpointRestorer', { inspect: () => Promise.reject(new Error('桩')) });
        return installCheckpoint(ctx.turnExtensions);
      }),
    '@xm/platform#secrets': (row) =>
      plugin(row, (ctx) =>
        ctx.provide('secrets', {
          backend: 'plaintext-unavailable',
          get: () => Promise.resolve(undefined),
          set: () => Promise.reject(new Error('桩')),
          delete: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
        }),
      ),
    '@xm/contracts#redact': (row) => plugin(row, (ctx) => ctx.provide('redact', redact)),
    '@xm/kernel#toolRegistry': (row) =>
      plugin(row, (ctx) => ctx.provide('tools', new ToolRegistry())),
    '@xm/runtime#sessionRuntime': (row) =>
      plugin(row, (ctx) =>
        ctx.provide('runtime', {
          open: (options) =>
            SessionRuntime.open({ ...options, store: new MemoryEventStore(), bus: new EventBus() }),
        }),
      ),
    '@xm/runtime#multimodalGuard': (row) =>
      plugin(row, (ctx) => installMultimodalGuard(ctx.turnExtensions)),
    '@xm/runtime#contextBuilder': (row) =>
      plugin(row, (ctx) => installContextBuilder(ctx.turnExtensions)),
    '@xm/runtime#resultTruncation': (row) =>
      plugin(row, (ctx) => installResultTruncation(ctx.turnExtensions)),
    '@xm/runtime#stoppingGuard': (row) =>
      plugin(row, (ctx) => installStoppingGuard(ctx.turnExtensions)),
    '@xm/tools-core#builtinTools': (row) => plugin(row, noop),
    '@xm/compose#testSurface': (row) => plugin(row, (ctx) => ctx.provide('surface', 'test')),
  };
};

const mountTable = async () => {
  const composed = await assembleProfile({
    profile: builtinProfile('test'),
    catalog: stubCatalog(),
  });
  const mounts = composed.container.mounts();
  await composed.dispose();

  const byEvent = new Map();
  for (const mount of mounts) {
    const list = byEvent.get(mount.event) ?? [];
    list.push(mount);
    byEvent.set(mount.event, list);
  }

  return (
    HEADER('扩展点挂载表') +
    '`test` profile 真装配一次之后，每个扩展点上挂着哪些插件行、按什么顺序派发。\n\n' +
    '顺序**就是**派发顺序：waterfall 上排在前面的先拿到 `next`，' +
    '所以这张表是"一次调用经过了什么"（ADR-0055）唯一可靠的答案。\n\n' +
    '注意四个内建 profile 的业务行相同，只有 surface 与 clock/ids 提供者不同，' +
    '因此这张表对 desktop / headless / cli 同样成立。\n\n' +
    '| 扩展点 | 顺序 | 插件行 |\n|---|---|---|\n' +
    [...byEvent.entries()]
      .flatMap(([event, list]) =>
        list.map(
          (mount, index) =>
            `| \`${event}\` | ${String(index + 1)} | \`${mount.plugin}\` |`,
        ),
      )
      .join('\n') +
    '\n'
  );
};

// ── 三、工具目录 ──────────────────────────────────────────────────

const allTools = () => {
  const noop = () => Promise.resolve(undefined);
  const ptyStub = {
    open: () => Promise.reject(new Error('桩')),
    write: noop,
    close: noop,
    list: () => [],
  };
  const editAccess = {
    get: () => undefined,
    put: () => undefined,
    markApplied: noop,
    markReviewed: noop,
    reviewed: () => false,
  };
  /*
   * 索引增强工具需要一个 WorkspaceIndex 才会被注册。以前这里不传，于是
   * `search.symbol` / `search.indexed` 两个**真实工具**从来没进过这张表——
   * 一份声称"全部内建工具"的目录漏掉两个，正是这张表最该拦住的那类漂移。
   */
  const indexStub = {
    state: () => 'cold',
    stats: () => ({ roots: [] }),
    refresh: () => Promise.resolve({ state: 'cold', indexed: 0, unchanged: 0, removed: 0, errors: [] }),
    clear: noop,
    searchText: () => [],
    searchSymbols: () => [],
    close: noop,
  };
  return [
    ...coreTools({ os: 'linux', tempDir: '/tmp', index: indexStub }),
    ...shellSessionTools(ptyStub),
    todoUpdateTool(noop),
    resultExpandTool(noop),
    editPreviewTool(editAccess),
    editApplyTool(editAccess),
    subagentExploreTool(noop),
  ];
};

/**
 * 规范输出值的顶层字段名（ADR-0071）。
 *
 * 读的是 Zod 4 的半公开内部 def，与 `contracts/src/tool/schema.ts` 同一姿势、同一风险：
 * zod 升级把它挪走时这里会当场炸，而不是悄悄产出一张空表。
 */
const outputFields = (tool) => Object.keys(tool.outputSchema?._zod?.def?.shape ?? {});

const toolTable = () => {
  const tools = allTools();

  /*
   * 闸门：内建工具**必须**声明 outputSchema（ADR-0071）。
   *
   * 放在这里而不是 `defineTool()` 里，是因为测试夹具与临时工具没有理由被迫定义规范值；
   * 而"内建工具集"这个概念只在这个脚本里被完整枚举过一次。`pnpm verify` 会跑
   * `generate-docs --check`，所以漏一个就是红的。
   */
  const missing = tools.filter((tool) => tool.outputSchema === undefined).map((t) => t.descriptor.name);
  if (missing.length > 0) {
    throw new Error(
      `这些内建工具没有声明 outputSchema：${missing.join('、')}。\n` +
        `规范输出值是 Code Mode 的前置（docs/10 §9.5.4 / ADR-0071）：程序拿不到结构就只能去解析散文。\n` +
        `给它加一个 z.strictObject()，并在 result 里 yield output。`,
    );
  }

  const rows = tools
    .map((tool) => ({
      name: tool.descriptor.name,
      group: tool.descriptor.group,
      risk: tool.descriptor.risk,
      capabilities: tool.descriptor.capabilities ?? [],
      concurrency: tool.descriptor.concurrency ?? '—',
      card: tool.presentCall !== undefined || tool.presentResult !== undefined ? '有' : '通用降级',
      actions: Object.keys(tool.actions ?? {}),
      output: outputFields(tool),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cell = (list) => (list.length === 0 ? '—' : list.map((v) => `\`${v}\``).join('、'));
  return (
    HEADER('工具目录') +
    '全部内建工具的能力、风险与卡片投影。**能力决定判定**（`evaluate()` 按能力匹配规则），' +
    '所以这一列是读权限行为最直接的入口。\n\n' +
    '「卡片」列为"通用降级"表示该工具没写 `presentCall`/`presentResult`，' +
    '渲染层按通用卡片显示——这是有意的默认，不是缺陷（ADR-0058）。\n\n' +
    '「规范输出值」列是该工具交给**程序**的那份结构的顶层字段（ADR-0071）。' +
    '它不进提示词、不落库；模型看到的仍是 `forModel` 那份散文。' +
    '**内建工具必须有这一列**，缺失时本脚本直接报错。\n\n' +
    `共 ${String(rows.length)} 个工具。\n\n` +
    '| 工具 | 分组 | 风险 | 能力 | 卡片 | 卡片动作 | 规范输出值 |\n|---|---|---|---|---|---|---|\n' +
    rows
      .map(
        (row) =>
          `| \`${row.name}\` | ${row.group} | ${row.risk} | ${cell(row.capabilities)} | ` +
          `${row.card} | ${cell(row.actions)} | ${cell(row.output)} |`,
      )
      .join('\n') +
    '\n'
  );
};

// ── 四、配置目录 ──────────────────────────────────────────────────

const unwrap = (schema) => {
  let node = schema;
  let optional = false;
  let defaultValue;
  for (;;) {
    const def = node?._zod?.def;
    if (def === undefined) return { node, optional, defaultValue };
    if (def.type === 'default' || def.type === 'prefault') {
      defaultValue = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      node = def.innerType;
      continue;
    }
    if (def.type === 'optional' || def.type === 'nullable') {
      optional = true;
      node = def.innerType;
      continue;
    }
    return { node, optional, defaultValue };
  }
};

const describe = (node) => {
  const def = node?._zod?.def;
  if (def === undefined) return '未知';
  switch (def.type) {
    case 'object':
      return '对象';
    case 'array':
      return '数组';
    case 'record':
      return '映射';
    case 'enum':
      // 用「、」而不是「|」：这一列落在 Markdown 表格里，竖线会把单元格劈开
      return `枚举（${Object.values(def.entries ?? {}).join('、')}）`;
    case 'literal':
      return `字面量 ${JSON.stringify(def.values?.[0])}`;
    case 'union':
      return '联合';
    default:
      return def.type;
  }
};

const configRows = (schema, prefix, rows) => {
  const { node } = unwrap(schema);
  const shape = node?._zod?.def?.shape;
  if (shape === undefined) return rows;
  for (const [key, child] of Object.entries(shape)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const { node: inner, optional, defaultValue } = unwrap(child);
    rows.push({
      path,
      type: describe(inner),
      optional,
      defaultValue: defaultValue === undefined ? '—' : JSON.stringify(defaultValue),
    });
    if (inner?._zod?.def?.type === 'object') configRows(inner, path, rows);
  }
  return rows;
};

const configTable = () => {
  const rows = configRows(Config, '', []);
  return (
    HEADER('配置目录') +
    '`config.json` 的全部字段，来自 `@xm/contracts` 的 `Config` schema。\n\n' +
    '层级：内置默认 < `${paths.config}/config.json` < 传入 cwd 的 `.xiaoming/config.json`。' +
    '**配置层刻意不接环境变量**——接上就等于给了一条"把密钥塞进 env"的合法路径，' +
    '而 `shell.exec` 会把整个环境原样交给子进程（docs/06）。\n\n' +
    `共 ${String(rows.length)} 个字段。\n\n` +
    '| 字段 | 类型 | 可选 | 默认值 |\n|---|---|---|---|\n' +
    rows
      .map(
        (row) =>
          `| \`${row.path}\` | ${row.type} | ${row.optional ? '是' : '否'} | ` +
          `${row.defaultValue === '—' ? '—' : `\`${row.defaultValue}\``} |`,
      )
      .join('\n') +
    '\n'
  );
};

// ── 主流程 ────────────────────────────────────────────────────────

const outputs = {
  '事件生产消费表.md': eventTable(),
  '扩展点挂载表.md': await mountTable(),
  '工具目录.md': toolTable(),
  '配置目录.md': configTable(),
};

const check = process.argv.includes('--check');
const stale = [];
for (const [name, content] of Object.entries(outputs)) {
  const path = join(OUT, name);
  if (check) {
    let actual = '';
    try {
      if (statSync(path).isFile()) actual = readFileSync(path, 'utf8');
    } catch {
      // 缺文件与内容过期走同一条提示
    }
    if (actual !== content) stale.push(name);
  } else {
    writeFileSync(path, content, 'utf8');
  }
}

if (check) {
  if (stale.length > 0) {
    console.error(`\n✗ 生成表与代码不一致：${stale.join('、')}`);
    console.error('  请运行 pnpm generate:docs 后把变更一并提交。\n');
    process.exit(1);
  }
  console.log(`✓ 四张生成表与代码一致（${Object.keys(outputs).join('、')}）。`);
} else {
  console.log(`✓ 已生成 ${Object.keys(outputs).length} 张表到 docs/generated/`);
}
