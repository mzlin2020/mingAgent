import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import { redact, type PersistedEvent } from '@xm/contracts';
import type {
  Checkpointer,
  CheckpointRestorer,
  ClockService,
  ContainerPlugin,
  IdService,
  InvariantRegistry,
  ExecutionWorld,
  RuleLayer,
  SecretStore,
  ToolGateway,
} from '@xm/kernel';
import {
  MemoryEventStore,
  ToolRegistry,
  createDeterministicClock,
  createDeterministicIds,
  pureGateway,
} from '@xm/kernel';
import {
  DEMO_ECHO,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  TurnExtensionHost,
  createInvariantRegistry,
  createTurnExtensionHost,
  echoTool,
  installCheckpoint,
  installContextBuilder,
  installMultimodalGuard,
  installResultTruncation,
  installStoppingGuard,
  runTurn,
  textInput,
} from '@xm/runtime';
import {
  assembleProfile,
  builtinProfile,
  withoutCodeRuntime,
  type PluginCatalog,
  type ProfileRow,
} from '@xm/compose';

interface RuntimeFactory {
  open(options: Omit<Parameters<typeof SessionRuntime.open>[0], 'clock' | 'ids'>): Promise<SessionRuntime>;
}

interface Services {
  clock: ClockService;
  ids: IdService;
  executor: ExecutionWorld;
  turnExtensions: TurnExtensionHost;
  invariants: InvariantRegistry;
  policy: readonly RuleLayer[];
  gateway: ToolGateway;
  checkpointer: Checkpointer;
  checkpointRestorer: CheckpointRestorer;
  secrets: SecretStore;
  redact: typeof redact;
  tools: ToolRegistry;
  runtime: RuntimeFactory;
  surface: string;
}

const plugin = (
  row: ProfileRow,
  apply: ContainerPlugin<Services>['apply'],
): ContainerPlugin<Services> => ({
  name: row.id,
  inject: row.inject as (keyof Services)[],
  provide: row.provide as (keyof Services)[],
  apply,
});

const catalogFor = (clock: ClockService, ids: IdService): PluginCatalog<Services> => ({
  '@xm/kernel#deterministicClock': (row) => plugin(row, (ctx) => ctx.provide('clock', clock)),
  '@xm/kernel#deterministicIds': (row) => plugin(row, (ctx) => ctx.provide('ids', ids)),
  '@xm/tool-runtime#localExecutor': (row) =>
    plugin(row, (ctx) => ctx.provide('executor', localExecutionWorld)),
  '@xm/runtime#invariants': (row) =>
    plugin(row, (ctx) => {
      const { registry, dispose } = createInvariantRegistry();
      ctx.provide('invariants', registry);
      return dispose;
    }),
  '@xm/runtime#turnDriver': (row) =>
    plugin(row, (ctx) => ctx.provide('turnExtensions', createTurnExtensionHost(ctx))),
  '@xm/kernel#policy': (row) => plugin(row, (ctx) => ctx.provide('policy', [])),
  '@xm/tool-runtime#gateway': (row) => plugin(row, (ctx) =>
    ctx.provide('gateway', pureGateway((toolName) => toolName))),
  '@xm/tool-runtime#checkpoint': (row) => plugin(row, (ctx) => {
    ctx.provide('checkpointer', { before: () => Promise.resolve(undefined) });
    ctx.provide('checkpointRestorer', {
      inspect: () => Promise.reject(new Error('本场景不读取 checkpoint')),
      restore: () => Promise.reject(new Error('本场景不恢复 checkpoint')),
    });
    return installCheckpoint(ctx.turnExtensions);
  }),
  '@xm/platform#secrets': (row) => plugin(row, (ctx) => ctx.provide('secrets', {
    backend: 'plaintext-unavailable',
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new Error('测试不保存密钥')),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  })),
  '@xm/contracts#redact': (row) => plugin(row, (ctx) => ctx.provide('redact', redact)),
  '@xm/kernel#toolRegistry': (row) => plugin(row, (ctx) => ctx.provide('tools', new ToolRegistry())),
  '@xm/runtime#sessionRuntime': (row) => plugin(row, (ctx) => ctx.provide('runtime', {
    open: (options) => SessionRuntime.open({
      ...options,
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
  '@xm/tools-core#builtinTools': (row) => plugin(row, (ctx) => {
    ctx.tools.register(echoTool());
    return () => ctx.tools.unregister(DEMO_ECHO);
  }),
  '@xm/compose#testSurface': (row) => plugin(row, (ctx) => ctx.provide('surface', 'test')),
});

const runScenario = async (composed: boolean): Promise<string> => {
  const clock = createDeterministicClock({ start: 1_700_000_000_000, step: 7 });
  const ids = createDeterministicIds(100);
  const store = new MemoryEventStore();
  const bus = new EventBus();
  let runtime: SessionRuntime;
  let tools: ToolRegistry;
  let extensions: TurnExtensionHost | undefined;
  let dispose = (): Promise<void> => Promise.resolve();

  if (composed) {
    const assembled = await assembleProfile({
      /*
       * 刻意去掉 Code Mode 那一行：它要拉一个 WASM 依赖，而这个用例验的是
       * "装配起来的事件流与手工拼的逐字节一致"。顺带这也是 `withoutCodeRuntime`
       * 的第一个消费者——不装它，其余一切照常（ADR-0072）。
       */
      profile: withoutCodeRuntime(builtinProfile('test')),
      catalog: catalogFor(clock, ids),
    });
    tools = assembled.container.context.tools;
    runtime = await assembled.container.context.runtime.open({
      sessionId: ids.session(),
      store,
      bus,
    });
    extensions = assembled.container.context.turnExtensions;
    dispose = () => assembled.dispose();
  } else {
    tools = new ToolRegistry();
    tools.register(echoTool());
    runtime = await SessionRuntime.open({ sessionId: ids.session(), store, bus, clock, ids });
  }

  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/deterministic', modelRef: 'scripted/test' },
  });
  const callId = ids.call();
  const provider = new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'tool_call_start', id: callId, name: DEMO_ECHO },
          { kind: 'tool_call_delta', id: callId, argsJson: '{"text":"hello"}' },
          { kind: 'tool_call_end', id: callId },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      { chunks: [{ kind: 'text_delta', text: 'done' }, { kind: 'stop', reason: 'end_turn' }] },
    ],
  });
  await runTurn(
    {
      runtime,
      executor: localExecutionWorld,
      provider,
      tools,
      layers: [],
      model: 'scripted-1',
      ...(extensions === undefined ? {} : { extensions }),
    },
    textInput('run'),
  );

  const events: PersistedEvent[] = [];
  for await (const event of store.read(runtime.sessionId)) events.push(event);
  await runtime.close();
  await dispose();
  return JSON.stringify(events);
};

describe('M3-b 确定性 profile 迁移快照', () => {
  it('直接装配与 profile 装配逐字节一致，重复 profile 运行也一致', async () => {
    const direct = await runScenario(false);
    const first = await runScenario(true);
    const second = await runScenario(true);

    expect(first).toBe(direct);
    expect(second).toBe(first);
    expect(first).toContain('"durationMs":21');
  });
});
