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

  /*
   * 回合进行中的注入是**产品默认路径**：子 Agent 的结论就是这样回传父会话的（ADR-0056 §四，
   * desktop 的 explore 已经这样接线）。它必须不破坏发给 Provider 的消息形状——
   * 角色严格交替、`tool_result` 打头，两条都由真实 Provider 强制，而 ScriptedProvider 不查。
   */
  it('工具执行途中注入：消息角色仍严格交替，tool_result 仍打头', async () => {
    const { runtime, ids } = await setup();
    const tools = new ToolRegistry();
    const agent = new Agent({ runtime, drive: () => Promise.resolve('end_turn') });
    tools.register(
      defineTool({
        name: 'test.spawn',
        group: 'test',
        description: '执行途中往父会话注入结论',
        inputSchema: z.strictObject({}),
        risk: 'safe',
        capabilities: ['env.read'],
        async *execute() {
          await agent.inject({
            content: [{ type: 'text', text: '子 Agent 结论' }],
            source: { kind: 'subagent', agentId: ids.agent() },
          });
          yield { kind: 'result', forModel: [{ type: 'text', text: '已注入' }] };
        },
      }),
    );
    const callId: CallId = ids.call();
    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: 'test.spawn' },
            { kind: 'tool_call_delta', id: callId, argsJson: '{}' },
            { kind: 'tool_call_end', id: callId },
            { kind: 'stop', reason: 'tool_use' },
          ],
        },
        { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
      ],
    });
    await runTurn(
      { runtime, executor: localExecutionWorld, provider, tools, layers: [], model: 'scripted-1' },
      textInput('派生一个子 Agent'),
    );

    const roles = runtime.state.messages.map((message) => message.role);
    expect(roles.every((role, index) => index === 0 || role !== roles[index - 1])).toBe(true);
    // 注入内容并进了那一步的 user 消息，而不是自己另起一条把 tool_result 挤走
    const bucket = runtime.state.messages.find((message) =>
      message.blocks.some((block) => block.type === 'tool_result'),
    );
    expect(bucket?.blocks[0]?.type).toBe('tool_result');
    expect(textOf(bucket?.blocks ?? [])).toBe('子 Agent 结论');
    // 真正发给 Provider 的那一份也必须是交替的
    const sent = provider.requests.at(-1)?.messages.map((message) => message.role) ?? [];
    expect(sent.every((role, index) => index === 0 || role !== sent[index - 1])).toBe(true);
    await runtime.close();
  });

  it('连续两次注入并进同一条 user 消息，不产生相邻同角色消息', async () => {
    const { runtime, ids } = await setup();
    const agent = new Agent({ runtime, drive: () => Promise.resolve('end_turn') });
    await agent.inject({
      content: [{ type: 'text', text: 'CI 通过' }],
      source: { kind: 'job', jobId: 'ci-1' },
    });
    await agent.inject({
      content: [{ type: 'text', text: '部署完成' }],
      source: { kind: 'subagent', agentId: ids.agent() },
    });
    expect(runtime.state.messages.map((message) => message.role)).toEqual(['user']);
    expect(textOf(runtime.state.messages[0]?.blocks ?? [])).toBe('CI 通过|部署完成');
    await runtime.close();
  });

  it('点停止同时丢掉未认领的排队输入，下一条消息不会把它们一起带出去', async () => {
    const { runtime } = await setup();
    const seen: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new Agent({
      runtime,
      drive: async (input, context) => {
        seen.push(textOf(input));
        await gate;
        return context.signal.aborted ? 'aborted' : 'end_turn';
      },
    });
    const first = agent.followup(textInput('A'));
    agent.followup(textInput('B'));
    agent.steer(textInput('S'));
    expect(agent.pending()).toHaveLength(2);

    expect(agent.interrupt()).toBe(true);
    expect(agent.pending()).toEqual([]);
    release?.();
    await first.completion;

    const second = agent.followup(textInput('C'));
    release?.();
    await second.completion;
    expect(seen).toEqual(['A', 'C']);
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
