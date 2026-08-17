import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AnyEvent, CallId } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import {
  InvariantError,
  MemoryEventStore,
  ToolRegistry,
  composeRules,
  defineTool,
  pureGateway,
} from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  createInvariantRegistry,
  runTurn,
  textInput,
  type TurnDeps,
} from '@xm/runtime';
import { localExecutionWorld } from '@xm/tool-runtime';

/**
 * 运行时不变量（ADR-0060）。
 *
 * 这一组的重点**不是**"不变量的逻辑对不对"——那部分是纯函数，怎么写都容易测绿。
 * 重点是它**真的挂在写入路径上**：本仓库栽过八次"规则存在但从未生效"，
 * `truncateResult` 有 12 条用例全绿而 `executeCall` 一次没调过它，就是最贵的一次。
 * 所以下面每一条都跑真实的 `record()` / `runTurn()`，不直接调注册表。
 */

const env = (root: string): PolicyEnv => ({
  home: root,
  sourceRoot: join(root, 'app'),
  dataDir: join(root, 'data'),
  configDir: join(root, 'config'),
});

/** 会把外部内容带进上下文的工具（`gui.capture` 属于三个污点来源之一） */
const captureTool = defineTool({
  name: 'test.capture',
  group: 'gui',
  description: '截屏',
  inputSchema: z.strictObject({}),
  risk: 'safe',
  capabilities: ['gui.capture'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async *execute() {
    yield { kind: 'result', forModel: [{ type: 'text', text: '一张截图里的文字' }] };
  },
});

/** 不可信上下文下应当被红线 `red.secrets-read-untrusted` 拒绝的工具 */
const secretsTool = defineTool({
  name: 'test.secrets',
  group: 'secrets',
  description: '读密钥',
  inputSchema: z.strictObject({}),
  risk: 'high',
  capabilities: ['secrets.read'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async *execute() {
    yield { kind: 'result', forModel: [{ type: 'text', text: 'sk-真的密钥' }] };
  },
});

const openSession = async (options: { readonly withInvariants: boolean }) => {
  const root = '/w';
  const { registry } = createInvariantRegistry();
  const bus = new EventBus();
  const seen: AnyEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  const runtime = await SessionRuntime.open({
    sessionId: newSessionId(),
    store: new MemoryEventStore(),
    bus,
    ...(options.withInvariants ? { invariants: registry } : {}),
  });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: root, modelRef: 'scripted/test' },
  });
  const tools = new ToolRegistry();
  tools.register(captureTool);
  tools.register(secretsTool);
  const deps: TurnDeps = {
    runtime,
    executor: localExecutionWorld,
    tools,
    layers: composeRules({ env: env(root) }),
    model: 'scripted-1',
    provider: new ScriptedProvider({ turns: [{ chunks: [{ kind: 'stop', reason: 'end_turn' }] }] }),
    gateway: pureGateway((toolName) => toolName),
  };
  return { runtime, deps, registry, seen };
};

const callTurn = (deps: TurnDeps, name: string, callId: CallId): Promise<unknown> =>
  runTurn(
    {
      ...deps,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              { kind: 'tool_call_start', id: callId, name },
              { kind: 'tool_call_delta', id: callId, argsJson: '{}' },
              { kind: 'tool_call_end', id: callId },
              { kind: 'stop', reason: 'tool_use' },
            ],
          },
          { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
    },
    textInput(`调用 ${name}`),
  );

describe('自省闸门真的挂在写入路径上', () => {
  it('一次没开始过的调用不许成功结束——直接从 record() 抛出', async () => {
    const { runtime } = await openSession({ withInvariants: true });
    await expect(
      runtime.record({
        type: 'tool.end',
        payload: {
          callId: newCallId(),
          ok: true,
          durationMs: 1,
          forModel: [{ type: 'text', text: '结果' }],
        },
      }),
    ).rejects.toBeInstanceOf(InvariantError);
    await runtime.close();
  });

  it('没装注册表就没有这道闸门（生产 profile 可以关掉它）', async () => {
    const { runtime } = await openSession({ withInvariants: false });
    await expect(
      runtime.record({
        type: 'tool.end',
        payload: {
          callId: newCallId(),
          ok: true,
          durationMs: 1,
          forModel: [{ type: 'text', text: '结果' }],
        },
      }),
    ).resolves.toBeDefined();
    await runtime.close();
  });
});

/**
 * ADR-0060 反向演练 3 的落点：**把 `trustLevel` 改回硬编码 `'model'`**
 * （`turn-tools.ts` 的 `requestOf`），这条用例必须在第一个真实会话里红。
 *
 * 它值钱的地方在于两条断言的**独立性**：第一条（红线拒绝）是常规测试，
 * 改坏实现时它会红——但它也是最容易被"顺手改一改预期"改绿的那种断言。
 * 第二条（整条事件流上没有不变量违例）改不动：要让它绿，只能让那次调用
 * 真的不发生。历史上那次事故活了整整一个里程碑，靠的就是没有第二条。
 */
describe('判定路径的不变量（ADR-0060 立身之本）', () => {
  it('不可信上下文下的 secrets.read 被红线拦下，且事件流上没有违例', async () => {
    const { runtime, deps, seen, registry } = await openSession({ withInvariants: true });

    await callTurn(deps, 'test.capture', newCallId());
    expect(runtime.state.untrustedContext?.viaCapability).toBe('gui.capture');

    const secretsCall = newCallId();
    await callTurn(deps, 'test.secrets', secretsCall);

    const denials = seen.filter(
      (e) => e.type === 'permission.decision' && e.payload.effect === 'deny',
    );
    expect(denials.map((e) => (e.payload as { ruleId?: string }).ruleId)).toContain(
      'red.secrets-read-untrusted',
    );
    // 被拒的调用连 tool.start 都不产生（闸门在执行之前，ADR-0065 §四）
    const starts = seen.filter((e) => e.type === 'tool.start');
    expect(starts.map((e) => (e.payload as { callId: CallId }).callId)).not.toContain(secretsCall);
    expect(registry.violations).toEqual([]);
    await runtime.close();
  });
});

describe('占用投影不得进事件流（M3.5-f）', () => {
  it('🔴 把占用字段塞进已有事件 payload → record() 抛不变量', async () => {
    const { runtime } = await openSession({ withInvariants: true });
    await expect(
      runtime.record({
        type: 'notice.posted',
        payload: {
          level: 'info',
          code: 'occupancy.probe',
          message: '不应落库',
          systemTokens: 10,
          toolsTokens: 20,
          conversationTokens: 30,
          capacityTokens: 8_000,
        },
      }),
    ).rejects.toThrow(/占用投影不得进事件流/);
    await runtime.close();
  });
});
