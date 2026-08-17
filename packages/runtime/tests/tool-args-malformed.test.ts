import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent, ToolProgress } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, defineTool } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * 🔴 解不开的入参 JSON 不许变成一次"没带参数"的调用（地基复审四 C1）。
 *
 * 这条用例的形状是刻意选的：受测工具的入参**全部可选**。
 *
 * 旧实现 `catch { return {} }` 在这种工具上不会报任何错——`{}` 能过 schema，
 * 于是工具带着一整套默认值**真的执行了**。模型以为自己让它读 `/tmp/target`，
 * 它读的是默认值；事件流里也没有任何痕迹说那段 JSON 曾经坏过。
 *
 * 最常见的成因不是模型犯傻，是 `max_tokens` 恰好落在参数中间——
 * 于是 `argsJson` 是一段合法 JSON 的**前缀**。
 */

const ENV = {
  home: '/home/ming',
  sourceRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

const CALLS: string[] = [];

/** 入参全可选：`{}` 也能过校验，所以"静默变 {}"在它身上就是"静默执行" */
const optionalInputTool = () =>
  defineTool({
    name: 'demo.all-optional',
    group: 'demo',
    description: '入参全可选的玩具工具。仅用于验证入参解码。',
    inputSchema: z.strictObject({ path: z.string().optional(), depth: z.number().optional() }),
    risk: 'safe',
    // 随便挂一个 opaque 能力：空能力集要登记白名单（ADR-0032 #5），
    // 而这条用例要验的是入参解码，不是判权
    capabilities: ['env.read'],
    concurrency: 'parallel',
    outputSchema: z.strictObject({ path: z.string() }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute(input): AsyncIterable<ToolProgress> {
      const path = input.path ?? '（默认值）';
      CALLS.push(path);
      yield { kind: 'result', forModel: [{ type: 'text', text: `跑过了：${path}` }], output: { path } };
    },
  });

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

const callWithRawArgs = (name: string, argsJson: string) => {
  const id = newCallId();
  return {
    chunks: [
      { kind: 'tool_call_start' as const, id, name },
      { kind: 'tool_call_delta' as const, id, argsJson },
      { kind: 'tool_call_end' as const, id },
      { kind: 'stop' as const, reason: 'tool_use' as const },
    ],
  };
};

async function run(argsJson: string): Promise<PersistedEvent[]> {
  CALLS.length = 0;
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  tools.register(optionalInputTool());

  await runTurn(
    {
      runtime,
      executor: localExecutionWorld,
      tools,
      layers: builtinLayers(ENV),
      model: 'scripted-1',
      provider: new ScriptedProvider({
        turns: [callWithRawArgs('demo.all-optional', argsJson), END] as never,
      }),
    },
    textInput('跑一下'),
  );

  const out: PersistedEvent[] = [];
  for await (const e of store.read(sessionId)) out.push(e);
  return out;
}

const ended = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
const started = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.start' ? [e.payload] : []));

describe('🔴 工具入参 JSON 解不开时的处置', () => {
  it('被 max_tokens 截断的入参：调用不执行，错误说的是"JSON 坏了"而不是"缺字段"', async () => {
    const all = await run('{"path":"/tmp/targ');

    // 一次都没跑——旧实现在这里会跑，而且是带着默认值跑
    expect(CALLS).toEqual([]);
    expect(started(all)).toHaveLength(0);

    const end = ended(all)[0];
    expect(end?.ok).toBe(false);
    expect(end?.error?.code).toBe('invalid_input');
    expect(end?.error?.message).toContain('不是合法的 JSON');
    // 原文进事件流：否则"它到底收到了什么"事后无从查起
    expect(end?.error?.message).toContain('{"path":"/tmp/targ');
    // 截断是最常见的成因，理由里直接说出来，模型才知道该整段重发
    expect(end?.error?.message).toContain('max_tokens');
  });

  it('合法入参照常执行', async () => {
    const all = await run('{"path":"/tmp/target"}');
    expect(CALLS).toEqual(['/tmp/target']);
    expect(ended(all)[0]?.ok).toBe(true);
  });

  /*
   * 空串**不是**坏 JSON：多数 Provider 对零参数工具发的就是空串，
   * 那时 `{}` 是它字面上的意思。把这条一并钉住，免得下次收紧时顺手把它也拒了。
   */
  it('空的 argsJson 仍然按"没有参数"处理', async () => {
    const all = await run('');
    expect(CALLS).toEqual(['（默认值）']);
    expect(ended(all)[0]?.ok).toBe(true);
  });
});
