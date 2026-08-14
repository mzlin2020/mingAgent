import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import type { ModelChunk } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, policyEnvFromPaths, pureGateway } from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import { EventBus, ScriptedProvider, SessionRuntime, demoTargetOf, runTurn, textInput } from '@xm/runtime';
import { defineTool } from '@xm/kernel';
import { z } from 'zod';

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
 * M3-e 之后，这组无 `tools-core` import 的运行时用例与物理删包演练分工明确：本文件固定
 * 空工具运行语义；`pnpm typecheck` / `pnpm smoke` 在包缺席时走 no-tools profile，固定真实
 * desktop 与 headless 装配也不依赖业务包存在。两条都通过才算兑现原则二。
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
    expect(tools.descriptors({
      cwd: '/w',
      executor: localExecutionWorld,
      platform: {
        secrets: 'plaintext-unavailable',
        shellSession: false,
        screenCapture: false,
        inputInjection: false,
        tray: false,
        notifications: false,
      },
      disabledTools: [],
    })).toEqual(
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
        executor: localExecutionWorld,
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
        executor: localExecutionWorld,
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
  it('disabled tools stay out of prompts and cannot bypass dispatch checks', async () => {
    const platform = nodePlatform({ appRoot: '/opt/xiaoming' });
    const paths = platform.paths();
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    let executions = 0;
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'demo.blocked',
        group: 'demo',
        description: 'disabled test fixture',
        inputSchema: z.strictObject({}),
        risk: 'low',
        capabilities: ['fs.read'],
        async *execute() {
          await Promise.resolve();
          executions += 1;
          yield { kind: 'result' as const, forModel: [{ type: 'text' as const, text: 'unexpected' }] };
        },
      }),
    );

    const callId = newCallId();
    const provider = new ScriptedProvider({
      capabilities: { maxOutput: 200_000 },
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: 'demo.blocked' },
            { kind: 'tool_call_delta', id: callId, argsJson: '{}' },
            { kind: 'tool_call_end', id: callId },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        { chunks: [{ kind: 'stop', reason: 'end_turn' }] satisfies ModelChunk[] },
      ],
    });
    const reason = await runTurn(
      {
        runtime,
        executor: localExecutionWorld,
        provider,
        tools,
        layers: builtinLayers(policyEnvFromPaths(paths)),
        model: 'scripted-1',
        hostOs: 'windows',
        gateway: pureGateway(demoTargetOf),
        pathCaseInsensitive: platform.os === 'windows',
        toolAvailability: {
          executor: localExecutionWorld,
          platform: platform.capabilities(),
          disabledTools: ['demo.blocked'],
        },
      },
      textInput('call the disabled tool'),
    );

    expect(reason).toBe('end_turn');
    // 即使 Provider 声称能输出 200K，主回合也只申请 16K，不再沿用旧的 128K。
    expect(provider.requests[0]?.maxOutputTokens).toBe(16_384);
    expect(provider.requests[0]?.system.map((segment) => segment.text).join('\n')).toContain(
      '优先执行',
    );
    expect(provider.requests[0]?.system.map((segment) => segment.text).join('\n')).toContain(
      '已知运行平台：windows',
    );
    expect(provider.requests[0]?.tools?.some((tool) => tool.name === 'demo.blocked') ?? false).toBe(false);
    expect(executions).toBe(0);
    const result = runtime.state.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result' && block.toolUseId === callId);
    expect(result?.type === 'tool_result' && result.isError).toBe(true);
  });
});
