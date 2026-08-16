import type { Profile, ProfileRow } from './types.js';

export const BUILTIN_PROFILE_NAMES = ['desktop', 'headless', 'cli', 'test'] as const;
export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

const baselineRows = (deterministic: boolean): readonly ProfileRow[] => [
  {
    id: 'baseline.clock',
    plugin: deterministic ? '@xm/kernel#deterministicClock' : '@xm/platform#localClock',
    inject: [],
    provide: ['clock'],
  },
  {
    id: 'baseline.ids',
    plugin: deterministic ? '@xm/kernel#deterministicIds' : '@xm/platform#localIds',
    inject: [],
    provide: ['ids'],
  },
  {
    id: 'baseline.turn-driver',
    plugin: '@xm/runtime#turnDriver',
    inject: [],
    provide: ['turnExtensions'],
  },
  {
    id: 'baseline.policy',
    plugin: '@xm/kernel#policy',
    inject: [],
    provide: ['policy'],
  },
  {
    id: 'baseline.gateway',
    plugin: '@xm/tool-runtime#gateway',
    inject: [],
    provide: ['gateway'],
  },
  {
    id: 'baseline.checkpoint',
    plugin: '@xm/tool-runtime#checkpoint',
    inject: ['turnExtensions'],
    provide: ['checkpointer', 'checkpointRestorer'],
  },
  {
    id: 'baseline.secrets',
    plugin: '@xm/platform#secrets',
    inject: [],
    provide: ['secrets'],
  },
  {
    id: 'baseline.redact',
    plugin: '@xm/contracts#redact',
    inject: [],
    provide: ['redact'],
  },
  {
    id: 'baseline.tools',
    plugin: '@xm/kernel#toolRegistry',
    inject: [],
    provide: ['tools'],
  },
  {
    id: 'baseline.runtime',
    plugin: '@xm/runtime#sessionRuntime',
    inject: ['clock', 'ids', 'policy', 'gateway', 'checkpointer', 'secrets', 'redact', 'tools'],
    provide: ['runtime'],
  },
];

const businessRows = (surface: BuiltinProfileName): readonly ProfileRow[] => [
  /*
   * 自省闸门（ADR-0060）。**是业务行不是基线行**，因为它可以被关掉：
   * 它在写入路径上多一次检查，四个内建 profile 都开着，生产装配可以去掉这一行。
   *
   * 去掉之后 `SessionRuntime` 拿不到注册表，那一步整个不存在——所以别的行
   * **不许把它写进 inject**：写了就等于"关掉自省"变成"应用起不来"。
   */
  {
    id: 'runtime.invariants',
    plugin: '@xm/runtime#invariants',
    inject: [],
    provide: ['invariants'],
  },
  {
    id: 'runtime.executor',
    plugin: '@xm/tool-runtime#localExecutor',
    inject: [],
    provide: ['executor'],
  },
  {
    id: 'runtime.multimodal',
    plugin: '@xm/runtime#multimodalGuard',
    inject: ['turnExtensions'],
    provide: [],
  },
  {
    id: 'runtime.context',
    plugin: '@xm/runtime#contextBuilder',
    inject: ['turnExtensions'],
    provide: [],
  },
  {
    id: 'runtime.result-truncation',
    plugin: '@xm/runtime#resultTruncation',
    inject: ['turnExtensions'],
    provide: [],
  },
  {
    id: 'runtime.stopping',
    plugin: '@xm/runtime#stoppingGuard',
    inject: ['turnExtensions'],
    provide: [],
  },
  /*
   * Code Mode 的隔离运行时（ADR-0069）。**是业务行不是基线行**：不装它，
   * `ctx.codeMode` 缺席、`run_code` 拿不到跑程序的地方，其余一切照常——
   * Code Mode 本来就是 opt-in（ADR-0061 §二），呈现模式默认还是 `native`。
   *
   * 与 `runtime.invariants` 同理，别的行**不许把它写进 inject**：写了就等于
   * "不装 Code Mode"变成"应用起不来"。
   */
  {
    id: 'runtime.code',
    plugin: '@xm/code-runtime#quickjsRuntime',
    inject: [],
    provide: ['codeRuntime'],
  },
  {
    id: 'tools.builtin',
    plugin: '@xm/tools-core#builtinTools',
    inject: ['runtime', 'tools', 'gateway', 'checkpointer', 'executor'],
    provide: [],
  },
  {
    id: `surface.${surface}`,
    plugin: `@xm/${surface === 'desktop' ? 'desktop' : 'compose'}#${surface}Surface`,
    inject: ['runtime', 'tools'],
    provide: ['surface'],
  },
];

const cloneRows = (rows: readonly ProfileRow[]): ProfileRow[] =>
  rows.map((row) => ({
    ...row,
    inject: [...row.inject],
    provide: [...row.provide],
    ...(row.config === undefined ? {} : { config: structuredClone(row.config) }),
  }));

export const builtinProfile = (name: BuiltinProfileName): Profile => ({
  name,
  rows: cloneRows([...baselineRows(name === 'test'), ...businessRows(name)]),
});

export const baselineOnlyProfile = (name: BuiltinProfileName): Profile => ({
  name,
  rows: cloneRows(baselineRows(name === 'test')),
});

/**
 * 保留完整运行时与表面，只移除可选的内建工具包。
 * 用于发行裁剪和 `tools-core` 物理缺席时的空工具世界。
 */
export const withoutBuiltinTools = (profile: Profile): Profile => ({
  name: profile.name,
  rows: cloneRows(profile.rows.filter((row) => row.id !== 'tools.builtin')),
});

/**
 * 去掉 Code Mode 那一行。裁剪发行版、或跑一个不带 WASM 依赖的装配时用。
 *
 * 与 `withoutBuiltinTools` 是同一个形状，但两者的分量不同：删业务工具是原则二的
 * 可检验约束，删 Code Mode 只是关掉一个 opt-in 特性。
 */
export const withoutCodeRuntime = (profile: Profile): Profile => ({
  name: profile.name,
  rows: cloneRows(profile.rows.filter((row) => row.id !== 'runtime.code')),
});

export const isBuiltinProfileName = (name: string): name is BuiltinProfileName =>
  (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name);

export const trustedBaseline = (name: BuiltinProfileName): readonly ProfileRow[] =>
  baselineRows(name === 'test');
