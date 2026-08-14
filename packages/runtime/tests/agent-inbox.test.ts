import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallId, ContentBlock } from '@xm/contracts';
import {
  MemoryEventStore,
  ToolRegistry,
  createDeterministicClock,
  createDeterministicIds,
  defineTool,
  emptySessionState,
  reduce,
} from '@xm/kernel';
import {
  Agent,
  AgentInbox,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  runTurn,
  textInput,
} from '@xm/runtime';

const setup = async () => {
  const store = new MemoryEventStore();
  const clock = createDeterministicClock({ start: 1000, step: 1 });
  const ids = createDeterministicIds(1);
  const sessionId = ids.session();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus(), clock, ids });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/workspace', modelRef: 'scripted/test' },
  });
  return { store, clock, ids, sessionId, runtime };
};

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('|');

describe('M3-d Agent 句柄与 Inbox', () => {
  it('inject 持久化但不唤醒空闲 Agent；重开后按 seq 只出现一次', async () => {
    const { store, clock, ids, sessionId, runtime } = await setup();
    let drives = 0;
    const agent = new Agent({
      runtime,
      drive: () => {
        drives += 1;
        return Promise.resolve('end_turn');
      },
    });
    await agent.inject({
      content: [{ type: 'text', text: 'CI 已完成' }],
      source: { kind: 'job', jobId: 'ci-1' },
    });
    expect(agent.idle).toBe(true);
    expect(drives).toBe(0);
    expect(runtime.state.messages.map((message) => textOf(message.blocks))).toEqual(['CI 已完成']);
    await runtime.close();

    const reopened = await SessionRuntime.open({
      sessionId,
      store,
      bus: new EventBus(),
      clock,
      ids,
    });
    expect(reopened.state.messages.map((message) => textOf(message.blocks))).toEqual(['CI 已完成']);
    const injected = [];
    for await (const event of reopened.read()) {
      if (event.type === 'context.injected') injected.push(event);
    }
    expect(injected).toHaveLength(1);
    await reopened.close();
  });

  it('steer 优先于 followup，两个队列内部保持 FIFO，认领后从易失队列消失', async () => {
    const { runtime } = await setup();
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const agent = new Agent({
      runtime,
      drive: async (input) => {
        seen.push(textOf(input));
        if (seen.length === 1) await firstGate;
        return 'end_turn';
      },
    });
    const first = agent.followup(textInput('A'));
    agent.followup(textInput('B'));
    agent.followup(textInput('C'));
    agent.steer(textInput('S1'));
    agent.steer(textInput('S2'));
    expect(agent.pending().map((item) => `${item.kind}:${textOf(item.content)}`)).toEqual([
      'steer:S1',
      'steer:S2',
      'followup:B',
      'followup:C',
    ]);
    releaseFirst?.();
    await first.completion;
    expect(seen).toEqual(['A', 'S1|S2', 'B|C']);
    expect(agent.pending()).toEqual([]);
    await runtime.close();
  });

  it('工具执行途中 steer 不取消在飞调用，tool.end 先于纠偏的新 turn.start', async () => {
    const { runtime, store, ids } = await setup();
    const tools = new ToolRegistry();
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    tools.register(
      defineTool({
        name: 'test.delayed',
        group: 'test',
        description: '等待测试放行',
        inputSchema: z.strictObject({}),
        risk: 'safe',
        capabilities: ['env.read'],
        concurrency: 'exclusive',
        async *execute() {
          started?.();
          await finishGate;
          yield { kind: 'result', forModel: [{ type: 'text', text: '写入完成' }] };
        },
      }),
    );
    const callId: CallId = ids.call();
    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: 'test.delayed' },
            { kind: 'tool_call_delta', id: callId, argsJson: '{}' },
            { kind: 'tool_call_end', id: callId },
            { kind: 'stop', reason: 'tool_use' },
          ],
        },
        { chunks: [{ kind: 'text_delta', text: '已按纠偏继续' }, { kind: 'stop', reason: 'end_turn' }] },
      ],
    });
    const agent = new Agent({
      runtime,
      drive: (input, context) =>
        runTurn(
          {
            runtime,
            executor: localExecutionWorld,
            provider,
            tools,
            layers: [],
            model: 'scripted-1',
            signal: context.signal,
            inbox: context.inbox,
          },
          input,
        ),
    });
    const first = agent.followup(textInput('开始'));
    await startedGate;
    agent.steer(textInput('别再做其它修改'));
    expect(agent.pending()[0]?.kind).toBe('steer');
    finish?.();
    await first.completion;

    const events = [];
    for await (const event of store.read(runtime.sessionId)) events.push(event);
    const toolEndIndex = events.findIndex(
      (event) => event.type === 'tool.end' && event.payload.callId === callId,
    );
    const steerTurnIndex = events.findIndex(
      (event) =>
        event.type === 'turn.start' &&
        event.payload.input.some(
          (block) => block.type === 'text' && block.text === '别再做其它修改',
        ),
    );
    expect(toolEndIndex).toBeGreaterThan(-1);
    expect(steerTurnIndex).toBeGreaterThan(toolEndIndex);
    await runtime.close();
  });

  it('带 net.fetch 来源的注入把污点粘性并入回放状态', async () => {
    const { runtime, ids } = await setup();
    const agent = new Agent({ runtime, drive: () => Promise.resolve('end_turn') });
    const callId = ids.call();
    await agent.inject({
      content: [{ type: 'text', text: '网页内容' }],
      source: { kind: 'plugin', pluginId: 'web' },
      untrustedContext: {
        callId,
        toolName: 'web.fetch',
        viaCapability: 'net.fetch',
        since: 1234,
      },
    });
    expect(runtime.state.untrustedContext).toEqual({
      callId,
      toolName: 'web.fetch',
      viaCapability: 'net.fetch',
      since: 1234,
    });
    await runtime.close();
  });

  it('未认领 followup 不落库，模拟崩溃回放不会产生孤儿回合', async () => {
    const { runtime, store, sessionId } = await setup();
    const inboxOnly = new AgentInbox();
    inboxOnly.enqueue('followup', textInput('尚未认领'));
    const events = [];
    for await (const event of store.read(sessionId)) events.push(event);
    const state = events.reduce(reduce, emptySessionState(sessionId));
    expect(state.messages.some((message) => textOf(message.blocks).includes('尚未认领'))).toBe(false);
    await runtime.close();
  });
});
