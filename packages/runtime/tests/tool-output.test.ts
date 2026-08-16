import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent } from '@xm/contracts';
import {
  MemoryEventStore,
  ToolRegistry,
  createDeterministicClock,
  createDeterministicIds,
  defineTool,
  pureGateway,
} from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  createDefaultTurnExtensions,
  runTurn,
  textInput,
} from '@xm/runtime';
import type { ToolResultObservation } from '@xm/runtime';

/**
 * 规范输出值走完整条十二步链（ADR-0071）。
 *
 * 这一组要证明的是三件事，第二件最容易在将来被"顺手改好"：
 *
 * 1. 工具 yield 的规范值**到得了** `tool/result`——它是 M3-h 子调用返回值的取值点。
 * 2. 它**不进事件流**。规范值与 `forModel`/`presentation` 大量重复且体积不受控
 *    （`fs.read` 的规范值里带着文件正文），落库就是把同一份内容存两遍——
 *    ADR-0050 / ADR-0070 已经修过两次这个形状。
 * 3. 形状不合工具自己的 schema 时**静默丢掉**，模型那一侧照常。
 *
 * 第 2 件没有编译期护栏，只有这条用例。所以它断言的不是"某个字段不在"，
 * 而是**整份事件流的 JSON 里搜不到那个只出现在规范值里的哨兵字符串**。
 */

/** 只出现在规范值里、绝不出现在模型可见内容里的哨兵 */
const SENTINEL = '仅规范值可见-9f3c';

const scenario = async (options: {
  readonly outputSchema?: z.ZodType;
  readonly output: unknown;
}) => {
  const clock = createDeterministicClock({ start: 1000, step: 1 });
  const ids = createDeterministicIds(1);
  const store = new MemoryEventStore();
  const runtime = await SessionRuntime.open({
    sessionId: ids.session(),
    store,
    bus: new EventBus(),
    clock,
    ids,
  });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/workspace', modelRef: 'scripted/test' },
  });

  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: 'test.emit',
      group: 'test',
      description: '产出规范输出值的测试工具',
      inputSchema: z.strictObject({ path: z.string() }),
      risk: 'safe',
      capabilities: ['fs.read'],
      pathInputs: ['path'],
      concurrency: 'parallel',
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      async *execute(input) {
        await Promise.resolve();
        yield {
          kind: 'result',
          forModel: [{ type: 'text', text: `读了 ${input.path}` }],
          output: options.output,
        };
      },
    }),
  );

  const callId = ids.call();
  const provider = new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'tool_call_start', id: callId, name: 'test.emit' },
          { kind: 'tool_call_delta', id: callId, argsJson: '{"path":"/workspace/a"}' },
          { kind: 'tool_call_end', id: callId },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
    ],
  });

  const extensions = await createDefaultTurnExtensions();
  const observed: ToolResultObservation[] = [];
  extensions.host.onToolResult((_signal, observation) => {
    observed.push(observation);
  });

  await runTurn(
    {
      runtime,
      executor: localExecutionWorld,
      provider,
      tools,
      layers: [],
      model: 'scripted-1',
      gateway: pureGateway((_name, input) => (input as { path: string }).path),
      extensions: extensions.host,
    },
    textInput('run'),
  );

  const events: PersistedEvent[] = [];
  for await (const event of store.read(runtime.sessionId)) events.push(event);
  await runtime.close();
  await extensions.dispose();
  return { events, observed, callId };
};

const Output = z.strictObject({ path: z.string(), note: z.string() });

describe('ADR-0071 规范输出值的全链路', () => {
  it('工具 yield 的规范值到达 tool/result，且已经过 schema 校验', async () => {
    const result = await scenario({
      outputSchema: Output,
      output: { path: '/workspace/a', note: SENTINEL },
    });
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0]?.result.output).toEqual({ path: '/workspace/a', note: SENTINEL });
  });

  it('🔴 规范值不落库：整份事件流里搜不到只在规范值里出现过的那个字符串', async () => {
    const result = await scenario({
      outputSchema: Output,
      output: { path: '/workspace/a', note: SENTINEL },
    });
    expect(JSON.stringify(result.events)).not.toContain(SENTINEL);

    // 反过来确认这条断言不是因为"事件流本来就是空的"而通过的
    const end = result.events.find((event) => event.type === 'tool.end');
    expect(end?.type === 'tool.end' ? end.payload.ok : undefined).toBe(true);
    expect(JSON.stringify(result.events)).toContain('读了 /workspace/a');
  });

  it('没声明 outputSchema：规范值被丢掉，模型可见内容照常', async () => {
    const result = await scenario({ output: { path: '/workspace/a', note: SENTINEL } });
    expect(result.observed[0]?.result.output).toBeUndefined();
    expect(JSON.stringify(result.events)).toContain('读了 /workspace/a');
  });

  it('形状对不上 schema：丢掉，不抛、不让这次调用失败', async () => {
    const result = await scenario({ outputSchema: Output, output: { path: 42 } });
    expect(result.observed[0]?.result.output).toBeUndefined();
    const end = result.events.find((event) => event.type === 'tool.end');
    expect(end?.type === 'tool.end' ? end.payload.ok : undefined).toBe(true);
  });
});
