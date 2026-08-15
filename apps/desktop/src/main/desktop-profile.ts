import { redact } from '@xm/contracts';
import type { ProfileRow } from '@xm/compose';
import {
  assembleProfile,
  loadPatchedProfile,
  withoutBuiltinTools,
  type AssembledProfile,
  type PluginCatalog,
} from '@xm/compose';
import type {
  Checkpointer,
  InvariantRegistry,
  CheckpointRestorer,
  ClockService,
  ContainerPlugin,
  ExecutionWorld,
  IdService,
  RegisteredTool,
  RuleLayer,
  SecretStore,
  ToolGateway,
} from '@xm/kernel';
import { ToolRegistry } from '@xm/kernel';
import {
  SessionRuntime,
  TurnExtensionHost,
  createInvariantRegistry,
  createTurnExtensionHost,
  installCheckpoint,
  installContextBuilder,
  installMultimodalGuard,
  installResultTruncation,
  installStoppingGuard,
} from '@xm/runtime';

type OpenRuntimeOptions = Omit<Parameters<typeof SessionRuntime.open>[0], 'clock' | 'ids'>;

export interface SessionRuntimeFactory {
  open(options: OpenRuntimeOptions): Promise<SessionRuntime>;
}

export interface DesktopProfileServices {
  readonly clock: ClockService;
  readonly ids: IdService;
  readonly executor: ExecutionWorld;
  readonly turnExtensions: TurnExtensionHost;
  readonly invariants: InvariantRegistry;
  readonly policy: readonly RuleLayer[];
  readonly gateway: ToolGateway;
  readonly checkpointer: Checkpointer;
  readonly checkpointRestorer: CheckpointRestorer;
  readonly secrets: SecretStore;
  readonly redact: typeof redact;
  readonly tools: ToolRegistry;
  readonly runtime: SessionRuntimeFactory;
  readonly surface: { readonly kind: 'desktop' };
}

export interface DesktopProfileOptions {
  readonly configDir: string;
  readonly clock: ClockService;
  readonly ids: IdService;
  readonly executor: ExecutionWorld;
  readonly policy: readonly RuleLayer[];
  readonly gateway: ToolGateway;
  readonly checkpointer: Checkpointer;
  readonly checkpointRestorer: CheckpointRestorer;
  readonly secrets: SecretStore;
  readonly tools: ToolRegistry;
  readonly createTools: () => readonly RegisteredTool[];
  readonly builtinToolsAvailable?: boolean;
}

const plugin = (
  row: ProfileRow,
  apply: ContainerPlugin<DesktopProfileServices>['apply'],
): ContainerPlugin<DesktopProfileServices> => ({
  name: row.id,
  inject: row.inject as (keyof DesktopProfileServices)[],
  provide: row.provide as (keyof DesktopProfileServices)[],
  apply,
});

export const assembleDesktopProfile = async (
  options: DesktopProfileOptions,
): Promise<AssembledProfile<DesktopProfileServices>> => {
  const patched = await loadPatchedProfile({ name: 'desktop', configDir: options.configDir });
  const profile = options.builtinToolsAvailable === false
    ? withoutBuiltinTools(patched)
    : patched;
  const catalog: PluginCatalog<DesktopProfileServices> = {
    '@xm/platform#localClock': (row) => plugin(row, (ctx) => ctx.provide('clock', options.clock)),
    '@xm/platform#localIds': (row) => plugin(row, (ctx) => ctx.provide('ids', options.ids)),
    '@xm/tool-runtime#localExecutor': (row) =>
      plugin(row, (ctx) => ctx.provide('executor', options.executor)),
    '@xm/runtime#invariants': (row) =>
      plugin(row, (ctx) => {
        const { registry, dispose } = createInvariantRegistry();
        ctx.provide('invariants', registry);
        return dispose;
      }),
    '@xm/runtime#turnDriver': (row) =>
      plugin(row, (ctx) => ctx.provide('turnExtensions', createTurnExtensionHost(ctx))),
    '@xm/kernel#policy': (row) => plugin(row, (ctx) => ctx.provide('policy', options.policy)),
    '@xm/tool-runtime#gateway': (row) =>
      plugin(row, (ctx) => ctx.provide('gateway', options.gateway)),
    '@xm/tool-runtime#checkpoint': (row) =>
      plugin(row, (ctx) => {
        ctx.provide('checkpointer', options.checkpointer);
        ctx.provide('checkpointRestorer', options.checkpointRestorer);
        return installCheckpoint(ctx.turnExtensions);
      }),
    '@xm/platform#secrets': (row) => plugin(row, (ctx) => ctx.provide('secrets', options.secrets)),
    '@xm/contracts#redact': (row) => plugin(row, (ctx) => ctx.provide('redact', redact)),
    '@xm/kernel#toolRegistry': (row) => plugin(row, (ctx) => ctx.provide('tools', options.tools)),
    '@xm/runtime#sessionRuntime': (row) =>
      plugin(row, (ctx) => ctx.provide('runtime', {
        /*
         * `invariants` 走 `has()` 而不是 inject：它是可关掉的一行（见 profiles.ts），
         * 写进 inject 就等于"生产装配去掉自省"变成"生产装配起不来"。
         * 这里是惰性求值——`open` 被调用时，全部行早就应用完了。
         */
        open: (runtimeOptions) => SessionRuntime.open({
          ...runtimeOptions,
          clock: ctx.clock,
          ids: ctx.ids,
          ...(ctx.has('invariants') ? { invariants: ctx.invariants } : {}),
        }),
      })),
    '@xm/runtime#multimodalGuard': (row) =>
      plugin(row, (ctx) => installMultimodalGuard(ctx.turnExtensions)),
    '@xm/runtime#contextBuilder': (row) =>
      plugin(row, (ctx) => installContextBuilder(ctx.turnExtensions)),
    '@xm/runtime#resultTruncation': (row) =>
      plugin(row, (ctx) => installResultTruncation(ctx.turnExtensions)),
    '@xm/runtime#stoppingGuard': (row) =>
      plugin(row, (ctx) => installStoppingGuard(ctx.turnExtensions)),
    '@xm/tools-core#builtinTools': (row) =>
      plugin(row, (ctx) => {
        const names: string[] = [];
        for (const tool of options.createTools()) {
          ctx.tools.register(tool);
          names.push(tool.descriptor.name);
        }
        return () => {
          for (const name of names.reverse()) ctx.tools.unregister(name);
        };
      }),
    '@xm/desktop#desktopSurface': (row) =>
      plugin(row, (ctx) => ctx.provide('surface', { kind: 'desktop' })),
  };
  return assembleProfile({ profile, catalog });
};
