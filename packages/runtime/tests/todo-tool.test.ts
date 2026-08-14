import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import type { ModelChunk, Todo } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolInputError, ToolRegistry } from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  TODO_UPDATE,
  runTurn,
  textInput,
  todoUpdateTool,
} from '@xm/runtime';

const TODOS: readonly Todo[] = [
  { id: 'inspect', content: '检查现有链路', status: 'completed' },
  {
    id: 'implement',
    content: '实现任务清单',
    status: 'in_progress',
    activeForm: '正在实现任务清单',
  },
];

describe('todo.update', () => {
  it('真实工具调用写入事件，状态与重开回放一致', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });

    const tools = new ToolRegistry();
    tools.register(
      todoUpdateTool(async ({ sessionId: target, todos }) => {
        expect(target).toBe(sessionId);
        const turnId = runtime.state.activeTurn?.turnId;
        await runtime.record({
          type: 'todo.updated',
          payload: { todos: [...todos] },
          ...(turnId === undefined ? {} : { turnId }),
        });
      }),
    );

    const callId = newCallId();
    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: callId, name: TODO_UPDATE },
            { kind: 'tool_call_delta', id: callId, argsJson: JSON.stringify({ todos: TODOS }) },
            { kind: 'tool_call_end', id: callId },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        { chunks: [{ kind: 'stop', reason: 'end_turn' }] satisfies ModelChunk[] },
      ],
    });

    await runTurn(
      { runtime, executor: localExecutionWorld, provider, tools, layers: [], model: 'scripted-1' },
      textInput('完成一个多步骤任务'),
    );

    expect(runtime.state.todos).toEqual(TODOS);
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toContain(TODO_UPDATE);
    expect(provider.requests[0]?.system.map((segment) => segment.text).join('\n')).toContain(
      '至少三个实质步骤',
    );

    const persisted = [];
    for await (const event of runtime.read()) persisted.push(event);
    expect(persisted.find((event) => event.type === 'todo.updated')?.turnId).toBeDefined();

    await runtime.close();
    const reopened = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    expect(reopened.state.todos).toEqual(TODOS);
    await reopened.close();
  });

  it('重复 id 失败且不调用 updater', async () => {
    let writes = 0;
    const tool = todoUpdateTool(() => {
      writes += 1;
      return Promise.resolve();
    });
    const ctx = {
      sessionId: newSessionId(),
      signal: {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      cwd: '/w',
      executor: localExecutionWorld,
    };

    const consume = async (): Promise<void> => {
      for await (const progress of tool.execute(
        {
          todos: [
            { id: 'same', content: '第一项', status: 'pending' },
            { id: 'same', content: '第二项', status: 'pending' },
          ],
        },
        ctx,
      )) {
        // 抽干执行流；本用例预期在产出结果前失败。
        void progress;
      }
    };

    await expect(consume()).rejects.toThrow(ToolInputError);
    expect(writes).toBe(0);
  });

  it('工具被禁用时，提示词不再引导模型调用它', async () => {
    const store = new MemoryEventStore();
    const runtime = await SessionRuntime.open({
      sessionId: newSessionId(),
      store,
      bus: new EventBus(),
    });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });
    const tools = new ToolRegistry();
    tools.register(todoUpdateTool(() => Promise.resolve()));
    const provider = new ScriptedProvider({
      turns: [{ chunks: [{ kind: 'stop', reason: 'end_turn' }] satisfies ModelChunk[] }],
    });

    await runTurn(
      {
        runtime,
        executor: localExecutionWorld,
        provider,
        tools,
        layers: [],
        model: 'scripted-1',
        toolAvailability: {
          executor: localExecutionWorld,
          platform: {
            secrets: 'plaintext-unavailable',
            shellSession: true,
            screenCapture: false,
            inputInjection: false,
            tray: false,
            notifications: false,
          },
          disabledTools: [TODO_UPDATE],
        },
      },
      textInput('简单任务'),
    );

    expect(provider.requests[0]?.tools).toEqual([]);
    expect(provider.requests[0]?.system.map((segment) => segment.text).join('\n')).not.toContain(
      'todo.update',
    );
    await runtime.close();
  });
});
