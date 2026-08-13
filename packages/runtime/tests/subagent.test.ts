import { z } from 'zod';
import type { ModelChunk } from '@xm/contracts';
import {
  newAgentId,
  newCallId,
  newMessageId,
  newSessionId,
  newTurnId,
} from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, defineTool, pureGateway } from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  recoverInterruptedSubagents,
  runSubagentExploration,
  runTurn,
  subagentExploreTool,
  textInput,
} from '@xm/runtime';
import { describe, expect, it } from 'vitest';

const END: ModelChunk = { kind: 'stop', reason: 'end_turn' };

const call = (id: ReturnType<typeof newCallId>, name: string, input: unknown): ModelChunk[] => [
  { kind: 'tool_call_start', id, name },
  { kind: 'tool_call_delta', id, argsJson: JSON.stringify(input) },
  { kind: 'tool_call_end', id },
];

function webTool() {
  return defineTool({
    name: 'web.fetch',
    group: 'web',
    description: '测试用只读网页工具',
    inputSchema: z.strictObject({ url: z.url() }),
    risk: 'low',
    capabilities: ['net.fetch'],
    hostInputs: ['url'],
    async *execute() {
      await Promise.resolve();
      yield {
        kind: 'result' as const,
        forModel: [{ type: 'text' as const, text: '外部原始载荷-不得回传父上下文' }],
      };
    },
  });
}

describe('M2-i 隔离子 Agent', () => {
  it('主循环真实派生独立 session，只回传结论并把网页污点粘性并回父会话', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const parentId = newSessionId();
    const parent = await SessionRuntime.open({ sessionId: parentId, store, bus });
    await parent.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
    });

    let forbiddenWrites = 0;
    const parentTools = new ToolRegistry();
    parentTools.register(webTool());
    parentTools.register(
      defineTool({
        name: 'edit.apply',
        group: 'edit',
        description: '绝不能进入子 Agent',
        inputSchema: z.strictObject({ path: z.string() }),
        risk: 'medium',
        capabilities: ['fs.write'],
        pathInputs: ['path'],
        async *execute() {
          await Promise.resolve();
          forbiddenWrites += 1;
          yield { kind: 'result' as const, forModel: [{ type: 'text' as const, text: '不应执行' }] };
        },
      }),
    );

    const webCall = newCallId();
    const forbiddenCall = newCallId();
    const childProvider = new ScriptedProvider({
      turns: [
        { chunks: [...call(webCall, 'web.fetch', { url: 'https://example.com' }), { kind: 'stop', reason: 'tool_use' }] },
        { chunks: [...call(forbiddenCall, 'edit.apply', { path: 'x.ts' }), { kind: 'stop', reason: 'tool_use' }] },
        { chunks: [{ kind: 'text_delta', text: '安全结论：网页信息已核对。' }, END] },
      ],
    });
    parentTools.register(
      subagentExploreTool(async (request) =>
        runSubagentExploration(
          {
            parentRuntime: parent,
            store,
            bus,
            parentTools,
            provider: childProvider,
            model: 'scripted-1',
            layers: [],
            gateway: pureGateway((_tool, input) =>
              typeof input === 'object' && input !== null && 'url' in input
                ? String(input.url)
                : '',
            ),
          },
          request,
        ),
      ),
    );

    const exploreCall = newCallId();
    const parentProvider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            ...call(exploreCall, 'agent.explore', {
              purpose: '核对网页并给结论',
              maxTurns: 4,
              timeoutMs: 10_000,
            }),
            { kind: 'stop', reason: 'tool_use' },
          ],
        },
        { chunks: [{ kind: 'text_delta', text: '父 Agent 收到结论。' }, END] },
      ],
    });
    expect(
      await runTurn(
        { runtime: parent, provider: parentProvider, tools: parentTools, layers: [], model: 'scripted-1' },
        textInput('请派子 Agent 调查'),
      ),
    ).toBe('end_turn');

    const summaries = await store.listSessions();
    const childSummary = summaries.find((item) => item.parentSessionId === parentId);
    expect(childSummary).toBeDefined();
    const childId = childSummary?.sessionId;
    if (childId === undefined) throw new Error('没有创建子会话');

    const parentEvents = [];
    for await (const event of store.read(parentId)) parentEvents.push(event);
    const childEvents = [];
    for await (const event of store.read(childId)) childEvents.push(event);
    const ended = parentEvents.find((event) => event.type === 'subagent.end');
    const webStart = childEvents.find(
      (event) => event.type === 'tool.start' && event.payload.callId === webCall,
    );
    expect(webStart?.type === 'tool.start' ? webStart.payload.capabilities : []).toContain(
      'net.fetch',
    );
    expect(ended?.type === 'subagent.end' ? ended.payload.reason : undefined).toBe('completed');
    expect(ended?.type === 'subagent.end' ? ended.payload.summary : []).toEqual([
      { type: 'text', text: '安全结论：网页信息已核对。' },
    ]);
    expect(parent.state.untrustedContext?.callId).toBe(webCall);
    expect(parent.state.untrustedContext?.viaCapability).toBe('net.fetch');
    expect(parent.state.runningSubagents.size).toBe(0);
    expect(parentEvents[0]?.seq).toBe(1);
    expect(childEvents[0]?.seq).toBe(1);
    expect(childEvents.some((event) => event.type === 'message.end')).toBe(true);
    expect(parentEvents.some((event) => event.sessionId === childId)).toBe(false);
    expect(JSON.stringify(parentEvents)).not.toContain('外部原始载荷-不得回传父上下文');
    expect(forbiddenWrites).toBe(0);

    const forbiddenEnd = childEvents.find(
      (event) => event.type === 'tool.end' && event.payload.callId === forbiddenCall,
    );
    expect(forbiddenEnd?.type === 'tool.end' ? forbiddenEnd.payload.ok : true).toBe(false);
    for (const request of childProvider.requests) {
      const names = request.tools?.map((tool) => tool.name) ?? [];
      expect(names).toContain('web.fetch');
      expect(names).not.toContain('edit.apply');
      expect(names).not.toContain('agent.explore');
    }
    await parent.close();
  });

  it('父取消与超时都完整收尾，不留下 runningSubagents', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const parent = await SessionRuntime.open({ sessionId: newSessionId(), store, bus });
    await parent.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
    });
    const parentTools = new ToolRegistry();

    const controller = new AbortController();
    const cancelProvider = new ScriptedProvider({
      turns: [{ chunks: [{ kind: 'text_delta', text: '尚未完成' }, END] }],
      chunkDelayMs: 30,
    });
    const cancelPromise = runSubagentExploration(
      { parentRuntime: parent, store, bus, parentTools, provider: cancelProvider, model: 'scripted-1', layers: [] },
      {
        parentCallId: newCallId(),
        purpose: '等待取消',
        maxTurns: 2,
        timeoutMs: 10_000,
        signal: controller.signal,
      },
    );
    controller.abort();
    const cancelled = await cancelPromise;
    expect(cancelled.reason).toBe('aborted');
    expect(parent.state.runningSubagents.size).toBe(0);

    const timeoutProvider = new ScriptedProvider({
      turns: [{ chunks: [{ kind: 'text_delta', text: '太慢' }, END] }],
      chunkDelayMs: 30,
    });
    const timedOut = await runSubagentExploration(
      { parentRuntime: parent, store, bus, parentTools, provider: timeoutProvider, model: 'scripted-1', layers: [] },
      {
        parentCallId: newCallId(),
        purpose: '等待超时',
        maxTurns: 2,
        timeoutMs: 5,
        signal: new AbortController().signal,
      },
    );
    expect(timedOut.reason).toBe('timeout');
    expect(parent.state.runningSubagents.size).toBe(0);
    await parent.close();
  });

  it('Provider 失败和应用重启补偿都产生 subagent.end，重启补偿也回传子污点', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const parentId = newSessionId();
    let parent = await SessionRuntime.open({ sessionId: parentId, store, bus });
    await parent.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
    });
    const failed = await runSubagentExploration(
      {
        parentRuntime: parent,
        store,
        bus,
        parentTools: new ToolRegistry(),
        provider: new ScriptedProvider({ turns: [] }),
        model: 'scripted-1',
        layers: [],
      },
      {
        parentCallId: newCallId(),
        purpose: '触发 Provider 失败',
        maxTurns: 1,
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      },
    );
    expect(failed.reason).toBe('failed');

    const agentId = newAgentId();
    const childId = newSessionId();
    const childCall = newCallId();
    await parent.record({
      type: 'subagent.start',
      payload: { agentId, childSessionId: childId, callId: newCallId(), purpose: '崩溃中的探索' },
    });
    const child = await SessionRuntime.open({ sessionId: childId, store, bus });
    await child.record({
      type: 'session.created',
      payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1', parentSessionId: parentId },
    });
    const turnId = newTurnId();
    await child.record({
      type: 'tool.start',
      turnId,
      payload: {
        callId: childCall,
        messageId: newMessageId(),
        name: 'web.fetch',
        input: { url: 'https://example.com' },
        risk: 'low',
        capabilities: ['net.fetch'],
      },
    });
    await child.close();
    await parent.close();

    parent = await SessionRuntime.open({ sessionId: parentId, store, bus });
    expect(parent.state.runningSubagents.size).toBe(1);
    expect(await recoverInterruptedSubagents(parent, store)).toBe(1);
    expect(parent.state.runningSubagents.size).toBe(0);
    expect(parent.state.untrustedContext?.callId).toBe(childCall);
    const ends = [];
    for await (const event of store.read(parentId)) {
      if (event.type === 'subagent.end') ends.push(event);
    }
    expect(ends.at(-1)?.payload.reason).toBe('interrupted');
    await parent.close();
  });
});
