import { createHash } from 'node:crypto';

import type { ModelChunk } from '@xm/contracts';
import { newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import { MemoryBlobStore, MemoryEventStore, ToolRegistry } from '@xm/kernel';
import {
  ContextBuilder,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  estimateRequestTokens,
  runTurn,
  textInput,
  todoUpdateTool,
} from '@xm/runtime';
import { describe, expect, it } from 'vitest';

const END: ModelChunk = { kind: 'stop', reason: 'end_turn' };
const PLATFORM = {
  secrets: 'keychain' as const,
  shellSession: true,
  screenCapture: true,
  inputInjection: true,
  tray: true,
  notifications: true,
};

const sha256 = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

async function addCompletedTurn(runtime: SessionRuntime, index: number): Promise<void> {
  const turnId = newTurnId();
  await runtime.record({
    type: 'turn.start',
    turnId,
    payload: {
      turnId,
      input: [{ type: 'text', text: `旧轮次-${String(index)}-用户约束-${'甲'.repeat(360)}` }],
    },
  });
  const messageId = newMessageId();
  await runtime.record({
    type: 'message.start',
    turnId,
    payload: { messageId, role: 'assistant', model: 'scripted-1' },
  });
  await runtime.record({
    type: 'message.end',
    turnId,
    payload: {
      message: {
        id: messageId,
        role: 'assistant',
        model: 'scripted-1',
        blocks: [{ type: 'text', text: `旧轮次-${String(index)}-已做决定-${'乙'.repeat(360)}` }],
        ts: index + 1,
      },
    },
  });
  await runtime.record({ type: 'turn.end', turnId, payload: { turnId, reason: 'end_turn' } });
}

describe('M2-h ContextBuilder', () => {
  it('在 75% 阈值压缩一次，持久复用摘要并保留近期原文', async () => {
    const store = new MemoryEventStore();
    const blobs = new MemoryBlobStore(sha256);
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
    });
    for (let index = 0; index < 8; index += 1) await addCompletedTurn(runtime, index);

    const summary =
      '未解决的问题：无。\n用户明确约束：保留旧轮次约束。\n已做出的决定：沿用既定方案。\n已完成工作与关键证据：前四轮已完成。';
    const provider = new ScriptedProvider({
      capabilities: { maxContext: 6_000, maxOutput: 600, promptCache: true },
      turns: [
        { chunks: [{ kind: 'text_delta', text: summary }, END] },
        { chunks: [END] },
      ],
    });
    const tools = new ToolRegistry();
    tools.register(todoUpdateTool(async () => Promise.resolve()));
    const deps = {
      runtime,
      provider,
      tools,
      layers: [],
      model: 'scripted-1',
      blobs,
      hostOs: 'linux' as const,
      toolAvailability: { executor: 'local' as const, platform: PLATFORM, disabledTools: [] },
    };

    expect(await runTurn(deps, textInput('当前消息必须原样保留'))).toBe('end_turn');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.toolChoice).toBe('none');

    const main = provider.requests[1];
    if (main === undefined) throw new Error('主请求未生成');
    const mainJson = JSON.stringify(main);
    expect(mainJson).not.toContain('旧轮次-0-用户约束');
    expect(mainJson).toContain('旧轮次-7-用户约束');
    expect(mainJson).toContain('当前消息必须原样保留');
    expect(main.system.map((item) => item.text).join('\n')).toContain(summary);

    const compaction = runtime.state.compactions[0];
    expect(compaction?.strategy).toBe('tiered-75-v1');
    expect(compaction?.model).toBe('scripted-1');
    expect(compaction?.tokensBefore).toBeGreaterThan(compaction?.tokensAfter ?? Number.MAX_VALUE);
    expect(runtime.state.compactions).toHaveLength(1);
    expect(estimateRequestTokens(main)).toBeLessThanOrEqual(
      6_000 - main.maxOutputTokens - (compaction?.reservedTokens ?? 0),
    );

    await runtime.close();
    const reopened = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    const replayProvider = new ScriptedProvider({
      capabilities: { maxContext: 100_000, maxOutput: 1_000 },
      turns: [],
    });
    const replayDeps = { ...deps, runtime: reopened, provider: replayProvider };
    const replayed = await new ContextBuilder(replayDeps).build(newTurnId());
    expect(replayProvider.requests).toHaveLength(0);
    expect(replayed.system.map((item) => item.text).join('\n')).toContain(summary);

    const disabled = await new ContextBuilder({
      ...replayDeps,
      toolAvailability: {
        executor: 'local',
        platform: PLATFORM,
        disabledTools: ['todo.update'],
      },
    }).build(newTurnId());
    expect(replayed.tools?.some((tool) => tool.name === 'todo.update')).toBe(true);
    expect(disabled.tools?.some((tool) => tool.name === 'todo.update')).toBe(false);
    expect(replayed.system[0]).toEqual(disabled.system[0]);
    expect(replayed.system[0]?.cacheable).toBe(true);
    await reopened.close();
    await blobs.close();
  });

  it('近期原文本身超过硬预算时失败关闭，不向 Provider 发送超限请求', async () => {
    const store = new MemoryEventStore();
    const runtime = await SessionRuntime.open({
      sessionId: newSessionId(),
      store,
      bus: new EventBus(),
    });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
    });
    for (let index = 0; index < 4; index += 1) await addCompletedTurn(runtime, index);

    const provider = new ScriptedProvider({
      capabilities: { maxContext: 1_000, maxOutput: 100 },
      turns: [],
    });
    const reason = await runTurn(
      { runtime, provider, tools: new ToolRegistry(), layers: [], model: 'scripted-1' },
      textInput('当前输入'),
    );
    expect(reason).toBe('error');
    expect(provider.requests).toHaveLength(0);
    expect(runtime.state.lastError?.message).toContain('超过输入预算');
    await runtime.close();
  });
});
