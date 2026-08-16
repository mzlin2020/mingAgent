import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelRequest, PersistedEvent } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, defineTool, pureGateway } from '@xm/kernel';
import { localExecutionWorld } from '@xm/tool-runtime';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  generateToolSdk,
  runCodeTool,
  runTurn,
  textInput,
} from '@xm/runtime';

/**
 * 呈现模式与 SDK 生成（ADR-0061 §二 / §五）。
 *
 * 呈现模式决定的是**模型视野**，不是权限。三种模式下判定完全一样——
 * `code` 模式里程序调 `fs.write` 与 `native` 模式里模型调 `fs.write` 走的是同一条链。
 * 这里断言的是"模型看得见什么"，以及"看不见的那些直接点名会怎样"。
 */

const echoTool = defineTool({
  name: 'demo.probe',
  group: 'demo',
  description: '探针工具',
  inputSchema: z.strictObject({
    path: z.string().describe('要读的路径'),
    lines: z.number().int().optional(),
    mode: z.enum(['fast', 'full']).default('fast'),
  }),
  risk: 'safe',
  capabilities: ['fs.read'],
  pathInputs: ['path'],
  outputSchema: z.strictObject({
    kind: z.enum(['text', 'binary']),
    hits: z.array(z.strictObject({ line: z.number().int(), text: z.string() })),
    note: z.string().optional(),
  }),
  async *execute() {
    await Promise.resolve();
    yield { kind: 'result', forModel: [{ type: 'text', text: 'ok' }] };
  },
});

const untypedTool = defineTool({
  name: 'demo.untyped',
  group: 'demo',
  description: '没声明规范输出值的工具',
  inputSchema: z.strictObject({ q: z.string() }),
  risk: 'safe',
  capabilities: ['fs.read'],
  pathInputs: [],
  async *execute() {
    await Promise.resolve();
    yield { kind: 'result', forModel: [{ type: 'text', text: 'ok' }] };
  },
});

describe('SDK 生成', () => {
  const sdk = generateToolSdk([echoTool, untypedTool]);

  it('点号变成嵌套对象，签名是同步的', () => {
    expect(sdk).toContain('  demo: {');
    expect(sdk).toContain('probe(input: {');
    expect(sdk).not.toContain('Promise<');
    expect(sdk).not.toContain('async ');
  });

  it('可选字段带 ?，带 default 的也算可选', () => {
    expect(sdk).toContain('lines?: number;');
    expect(sdk).toContain('mode?: "fast" | "full";');
    expect(sdk).toContain('path: string; // 要读的路径');
  });

  it('返回类型来自 outputSchema；没声明的写 unknown，而不是编一个形状', () => {
    expect(sdk).toContain('kind: "text" | "binary";');
    expect(sdk).toContain('hits: Array<{');
    expect(sdk).toContain('untyped(input: {\n      q: string;\n    }): unknown;');
  });

  it('同一份工具集生成的文本逐字节稳定——它要进 prompt cache 的稳定前缀', () => {
    expect(generateToolSdk([echoTool, untypedTool])).toBe(sdk);
  });
});

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

const callTurn = (name: string, args: unknown) => {
  const id = newCallId();
  return {
    chunks: [
      { kind: 'tool_call_start' as const, id, name },
      { kind: 'tool_call_delta' as const, id, argsJson: JSON.stringify(args) },
      { kind: 'tool_call_end' as const, id },
      { kind: 'stop' as const, reason: 'tool_use' as const },
    ],
  };
};

async function turn(
  presentation: 'native' | 'code' | 'both',
  turns: readonly { readonly chunks: unknown }[] = [END],
): Promise<{ requests: readonly ModelRequest[]; events: PersistedEvent[] }> {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const session = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await session.record({
    type: 'session.created',
    payload: { cwd: '/workspace', modelRef: 'scripted/scripted-1' },
  });
  const tools = new ToolRegistry();
  tools.register(echoTool);
  tools.register(runCodeTool());
  const provider = new ScriptedProvider({ turns: turns as never });
  await runTurn(
    {
      runtime: session,
      executor: localExecutionWorld,
      tools,
      layers: [],
      model: 'scripted-1',
      gateway: pureGateway((_name, input) => (input as { path?: string }).path ?? ''),
      provider,
      toolPresentation: presentation,
    },
    textInput('干活'),
  );
  await session.close();
  const events: PersistedEvent[] = [];
  for await (const event of store.read(sessionId)) events.push(event);
  return { requests: provider.requests, events };
}

const toolNames = (request: ModelRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.name).sort();
const systemText = (request: ModelRequest | undefined) =>
  (request?.system ?? []).map((segment) => segment.text).join('\n');

describe('呈现模式（ADR-0061 §二）', () => {
  it('native 是默认：模型看不到 run_code，也没有 SDK 段', async () => {
    const { requests } = await turn('native');
    expect(toolNames(requests[0])).toEqual(['demo.probe']);
    expect(systemText(requests[0])).not.toContain('declare const xm');
  });

  it('code：模型只看得到 run_code，SDK 段替掉了那一堆 schema', async () => {
    const { requests } = await turn('code');
    expect(toolNames(requests[0])).toEqual(['run_code']);
    const system = systemText(requests[0]);
    expect(system).toContain('declare const xm');
    expect(system).toContain('probe(input: {');
    // run_code 自己不在 SDK 里——不做嵌套（ADR-0061 §六）
    expect(system).not.toContain('run_code(input:');
  });

  it('both：两条路都给，SDK 段照样在', async () => {
    const { requests } = await turn('both');
    expect(toolNames(requests[0])).toEqual(['demo.probe', 'run_code']);
    expect(systemText(requests[0])).toContain('declare const xm');
  });

  /**
   * 🔴 `code` 模式下模型直接点名别的工具，得到的是"**没有这个工具**"，
   * 而不是"这次调用被拒绝"（ADR-0061 §二）。
   *
   * 两者在事件流里长得不一样，而这正是要的：被拒绝意味着"你想做的事不被允许"，
   * 不存在意味着"你记错了自己有什么"。混成一种，模型会去试着换个说法再来一次。
   */
  it('🔴 code 模式下模型直接调别的工具：判定之前就是"没有这个工具"', async () => {
    const { events } = await turn('code', [callTurn('demo.probe', { path: '/a' }), END]);
    const ends = events.flatMap((event) => (event.type === 'tool.end' ? [event.payload] : []));
    expect(ends[0]?.ok).toBe(false);
    expect(ends[0]?.error?.code).toBe('tool_not_found');
    // 没走到判定，所以一条 permission 事件都没有
    expect(events.filter((event) => event.type === 'permission.decision')).toHaveLength(0);
    // 也没真跑：tool.start 压根没落
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(0);
  });

  it('native 模式下模型点名 run_code：同样是"没有这个工具"', async () => {
    const { events } = await turn('native', [callTurn('run_code', { source: 'return 1;' }), END]);
    const ends = events.flatMap((event) => (event.type === 'tool.end' ? [event.payload] : []));
    expect(ends[0]?.error?.code).toBe('tool_not_found');
  });
});
