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
  {
    id: 'tools.builtin',
    plugin: '@xm/tools-core#builtinTools',
    inject: ['runtime', 'tools', 'gateway', 'checkpointer'],
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

export const isBuiltinProfileName = (name: string): name is BuiltinProfileName =>
  (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name);

export const trustedBaseline = (name: BuiltinProfileName): readonly ProfileRow[] =>
  baselineRows(name === 'test');
