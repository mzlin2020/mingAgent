import { describe, expect, it } from 'vitest';
import type { ModelChunk } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, policyEnvFromPaths, pureGateway } from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import { EventBus, ScriptedProvider, SessionRuntime, demoTargetOf, runTurn, textInput } from '@xm/runtime';

/**
 * 原则二（docs/01）的验收约束："删掉 `packages/tools-core` 后，内核 + UI 必须仍能
 * 启动（只是没有工具可用）"——ADR-0032 #6 指出这条约束从来没有被验证过。
 *
 * ── 这条测试证明了什么，没有证明什么（如实写清楚，不要让绿色的勾撒谎）──
 *
 * **证明了**：`@xm/kernel`/`@xm/runtime`/`@xm/storage`/`@xm/platform` 这一整条
 * 装配链——会话创建、事件持久化、模型流式对话、工具注册表——在**一个工具都没有**
 * 的情况下完整可用；本文件从头到尾没有 `import` 任何 `@xm/tools-core` 的东西
 * （这本身由 `.dependency-cruiser.cjs` 新增的"内核与装配层不得依赖 tools-core"
 * 规则做静态保证，这里做的是运行期的行为保证：不只是"编译得过"，是"真的能跑完
 * 一轮对话"）。模型试图调用一个不存在的工具时，`turn.ts` 的 `dispatchCall` 走
 * `tool_not_found` 分支优雅降级（一条错误的 `tool_result` 回给模型），不是让
 * 整个进程炸掉——这正是"没有工具可用但照常启动"里"照常"的含义。
 *
 * **没有证明什么**：`apps/desktop` 这个真实应用删掉 `packages/tools-core` 之后
 * 仍能启动。`apps/desktop/src/main/services.ts` 目前**硬编码 import**
 * `nodeToolGateway`/`nodeCheckpointer`/`coreTools`/`shellSessionTools`/
 * `PtySessionManager`——删掉 `tools-core` 会让这个文件直接编译不过，应用根本
 * 起不来。这不是本轮修的范围：让网关/checkpointer 变成可插拔端口、`services.ts`
 * 在包不存在时优雅降级，是 M3 插件宿主落地时要做的真实设计工作（ADR-0032 决策表
 * 里明确"不提前做"的一项）。这条测试只锁住"内核层本来就没有这个耦合"这一半，
 * 且专门在这份注释里把另一半的缺口写清楚，不让这条测试的绿色误导人以为整个
 * 验收约束已经满足。
 */
describe('内核 + 装配层不依赖 packages/tools-core（原则二，ADR-0032 #6）', () => {
  it('工具注册表一个工具都没有时，完整的一轮对话仍然能跑完（会话创建/落库/回放/流式全部正常）', async () => {
    const platform = nodePlatform({ appRoot: '/opt/xiaoming' });
    const paths = platform.paths();
    const layers = builtinLayers(policyEnvFromPaths(paths));

    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    // 空注册表——一个工具都没有，就是"删掉 tools-core"之后内核这一侧的真实处境
    const tools = new ToolRegistry();
    expect(tools.descriptors({ cwd: '/w', executor: 'local', platformCapabilities: [], disabledTools: [] })).toEqual(
      [],
    );

    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'text_delta', text: '你好，我没有任何工具可用，但我还是能正常回复。' },
            { kind: 'usage', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
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
      textInput('你好'),
    );

    expect(reason).toBe('end_turn');
    // 事件流是唯一真相：重新回放一遍，状态必须完整、一致
    const events = [];
    for await (const e of store.read(sessionId)) events.push(e);
    expect(events.length).toBeGreaterThan(0);
    expect(runtime.state.messages.at(-1)?.blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('模型试图调用一个不存在的工具：优雅降级为一条错误结果，不炸整个 turn', async () => {
    const platform = nodePlatform({ appRoot: '/opt/xiaoming' });
    const paths = platform.paths();
    const layers = builtinLayers(policyEnvFromPaths(paths));

    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    const tools = new ToolRegistry(); // 空注册表：模拟 tools-core 被删掉之后的状态
    const callId = newCallId();

    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: 'fs.read' }, // tools-core 才有的工具，这里查不到
            { kind: 'tool_call_delta', id: callId, argsJson: '{"path":"a.txt"}' },
            { kind: 'tool_call_end', id: callId },
            { kind: 'usage', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        {
          chunks: [
            { kind: 'text_delta', text: '看来这个工具不存在，我换个说法回答。' },
            { kind: 'usage', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
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
      textInput('读一下 a.txt'),
    );

    // 没有崩溃、没有抛出未捕获的异常——turn 正常走完两轮剧本，以 end_turn 收尾
    expect(reason).toBe('end_turn');
    expect(provider.consumedTurns).toBe(2);

    // 工具结果里带着"工具不存在"，模型看到的是一个可以理解的错误，不是进程崩溃
    const toolResultBlock = runtime.state.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === 'tool_result' && b.toolUseId === callId);
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock?.type === 'tool_result' && toolResultBlock.isError).toBe(true);
  });
});
