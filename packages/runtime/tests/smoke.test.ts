import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AnyEvent, ModelChunk } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import {
  ToolRegistry,
  builtinLayers,
  pureGateway,
  emptySessionState,
  policyEnvFromPaths,
  reduce,
} from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import { openStores } from '@xm/storage';
import {
  DEMO_ECHO,
  DEMO_FAKE_DELETE,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  demoTargetOf,
  echoTool,
  fakeDeleteTool,
  runTurn,
  textInput,
} from '@xm/runtime';

const ROOT = mkdtempSync(join(tmpdir(), 'xm-smoke-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const APP_ROOT = '/opt/xiaoming';

/**
 * headless 冒烟：**无 GUI、无网络、真 SQLite，跑通一轮完整对话。**
 *
 * 它验的不是某个函数，而是几条到 M0-a 为止只存在于文档里的架构约束：
 *
 *   · runtime 能在纯 Node 下装配起来（`apps/cli` 的前提，ADR-0007 / docs/09 A2）
 *   · 事件流是唯一真相：关掉进程、重开库、逐条 reduce，得到的状态必须与内存里的一致
 *   · 权限闸门长在工具调用的**路径上**，不是长在文档里
 *   · ADR-0008 的持久化分层在真库上成立：瞬态事件一条也不许落盘
 */
describe('headless 冒烟：一轮完整对话', () => {
  it('模型流式输出 → 工具调用过闸门 → 落库 → 重开库回放出同一个状态', async () => {
    const dataDir = join(ROOT, 'run1');
    const platform = nodePlatform({ appRoot: APP_ROOT, dataDir });
    const paths = platform.paths();
    const stores = await openStores(paths);
    const layers = builtinLayers(policyEnvFromPaths(paths));

    const bus = new EventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus });

    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1', title: '冒烟会话' },
    });

    const tools = new ToolRegistry();
    tools.register(echoTool());
    tools.register(fakeDeleteTool());

    const echoCall = newCallId();
    const denyCall = newCallId();
    const askCall = newCallId();

    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'thinking_delta', text: '先回显，再试两次删除。' },
            { kind: 'text_delta', text: '好的，我来试试。' },
            { kind: 'tool_call_start', id: echoCall, name: DEMO_ECHO },
            { kind: 'tool_call_delta', id: echoCall, argsJson: '{"text":"你好' },
            { kind: 'tool_call_delta', id: echoCall, argsJson: '，小明"}' },
            { kind: 'tool_call_end', id: echoCall },
            { kind: 'tool_call_start', id: denyCall, name: DEMO_FAKE_DELETE },
            // 家目录 —— 红线 red.fs-delete-home-root
            { kind: 'tool_call_delta', id: denyCall, argsJson: JSON.stringify({ path: paths.home }) },
            { kind: 'tool_call_end', id: denyCall },
            { kind: 'tool_call_start', id: askCall, name: DEMO_FAKE_DELETE },
            // 普通路径 —— def.fs-delete 的 ask
            { kind: 'tool_call_delta', id: askCall, argsJson: '{"path":"/tmp/xm-demo"}' },
            { kind: 'tool_call_end', id: askCall },
            {
              kind: 'usage',
              usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        {
          chunks: [
            { kind: 'text_delta', text: '做完了。' },
            {
              kind: 'usage',
              usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            { kind: 'stop', reason: 'end_turn' },
          ] satisfies ModelChunk[],
        },
      ],
    });

    const reason = await runTurn(
      {
        runtime,
        provider,
        tools,
        layers,
        model: 'scripted-1',
        gateway: pureGateway(demoTargetOf),
        pathCaseInsensitive: platform.os === 'windows',
      },
      textInput('试一下这几个工具'),
    );

    expect(reason).toBe('end_turn');
    expect(provider.consumedTurns, '剧本应恰好跑完两轮').toBe(2);

    // ── 闸门确实长在路径上 ──
    const decisions = seen.filter((e) => e.type === 'permission.decision');
    // 只有被拒的那次留痕（ADR-0039）：放行不产生权限事件，echo 零能力也不产生
    expect(decisions).toHaveLength(1);
    expect(decisions.map((e) => (e.payload as { effect: string }).effect)).toEqual(['deny']);
    expect(
      (decisions[0]?.payload as { ruleId?: string }).ruleId,
      '删家目录必须是红线拦的，不是兜底',
    ).toBe('red.fs-delete-home-root');
    expect(
      (decisions[0]?.payload as { by?: string }).by,
      '拒绝是判定做的决定，事件流里不该再有 by: user',
    ).toBe('policy');

    // ── 三次调用的结局 ──
    const ends = seen.filter((e) => e.type === 'tool.end');
    expect(ends).toHaveLength(3);
    const byCall = new Map(ends.map((e) => [(e.payload as { callId: string }).callId, e.payload]));
    expect((byCall.get(echoCall) as { ok: boolean }).ok).toBe(true);
    expect((byCall.get(denyCall) as { ok: boolean }).ok).toBe(false);
    expect((byCall.get(denyCall) as { error?: { code: string } }).error?.code).toBe('policy_denied');
    expect((byCall.get(askCall) as { ok: boolean }).ok).toBe(true);

    // 被拒的那次一次都没执行过：只有两条 tool.start
    expect(seen.filter((e) => e.type === 'tool.start')).toHaveLength(2);

    const memoryState = runtime.state;
    await runtime.close();
    await stores.close();

    // ── 重开库：事件流是唯一真相 ──
    const reopened = await openStores(paths);
    try {
      let replayed = emptySessionState(sessionId);
      const persistedTypes: string[] = [];
      for await (const e of reopened.events.read(sessionId)) {
        persistedTypes.push(e.type);
        replayed = reduce(replayed, e);
      }

      expect(replayed, '回放出的状态必须与进程内的完全一致').toEqual(memoryState);
      expect(replayed.messages.length).toBeGreaterThan(0);
      expect(replayed.status).toBe('idle');
      expect(replayed.usage.usage.inputTokens).toBe(320);

      // ADR-0008：瞬态事件一条也不许落盘
      expect(persistedTypes).not.toContain('message.delta');
      expect(persistedTypes).not.toContain('tool.progress');
      // 但它们确实在总线上出现过 —— 否则 UI 就没有流式效果
      expect(seen.some((e) => e.type === 'message.delta')).toBe(true);
      expect(seen.some((e) => e.type === 'tool.progress')).toBe(true);

      // 会话摘要投影也在盘上
      const list = await reopened.events.listSessions();
      expect(list[0]?.title).toBe('冒烟会话');
      expect(list[0]?.lastSeq).toBe(replayed.lastSeq);
    } finally {
      await reopened.close();
    }
  });

  /**
   * ── 这条用例的前身：「没有应答者时 ask 等同于拒绝」──
   *
   * 那时 `TurnDeps.decide` 是可选的，不传就等于所有 ask 都被拒——**默认放行等于没有闸门**。
   * ADR-0039 删掉了 ask 与应答者，那个判断点不存在了；同一个位置现在要钉的是相反方向的
   * 事情：**没有任何"要不要问"的开关之后，拒绝清单本身仍然是唯一的闸门。**
   *
   * 用的还是同一个 `fakeDelete` 工具与同一个家目录路径——它撞的是红线，
   * 而红线在第 1 步、跨层最先判，与有没有人在旁边看着完全无关。
   */
  it('没有任何人在旁边看着，红线照样拦得住 —— 闸门是规则，不是确认框', async () => {
    const platform = nodePlatform({ appRoot: APP_ROOT, dataDir: join(ROOT, 'run2') });
    const paths = platform.paths();
    const stores = await openStores(paths);
    const layers = builtinLayers(policyEnvFromPaths(paths));
    const bus = new EventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });

    const tools = new ToolRegistry();
    tools.register(fakeDeleteTool());
    const callId = newCallId();
    const home = paths.home;

    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: DEMO_FAKE_DELETE },
            { kind: 'tool_call_delta', id: callId, argsJson: JSON.stringify({ path: home }) },
            { kind: 'tool_call_end', id: callId },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        { chunks: [{ kind: 'stop', reason: 'end_turn' }] satisfies ModelChunk[] },
      ],
    });

    await runTurn(
      { runtime, provider, tools, layers, model: 'scripted-1', gateway: pureGateway(demoTargetOf) },
      textInput('删掉家目录'),
    );

    const end = seen.find((e) => e.type === 'tool.end');
    expect((end?.payload as { ok: boolean }).ok).toBe(false);
    // 不再是 user_rejected：没有用户参与，这是策略判的
    expect((end?.payload as { error?: { code: string } }).error?.code).toBe('policy_denied');
    expect(seen.filter((e) => e.type === 'tool.start')).toHaveLength(0);

    await runtime.close();
    await stores.close();
  });
});
