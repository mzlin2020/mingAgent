import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newCallId, newMessageId, newSessionId } from '@xm/contracts';
import type { ToolCard } from '@xm/contracts';
import {
  ToolRegistry,
  defineTool,
  emptySessionState,
  projectCallCard,
  projectResultCard,
  projectSessionCards,
} from '../src/index.js';
import type { SessionState } from '../src/index.js';

/**
 * 卡片投影的降级契约（ADR-0058 §三）。
 *
 * 这一组守的是同一句话：**展示路径永远不该让回放崩掉**。
 * 小明的整个 UI 就是 `reduce(events)` 的投影，回放崩了等于会话打不开——
 * 比"卡片好不好看"要紧得多。
 */

const Input = z.strictObject({ path: z.string() });

const toolWith = (options: {
  presentCall?: (input: { path: string }) => ToolCard | undefined;
  presentResult?: (input: { path: string }) => ToolCard | undefined;
  presentationSchema?: z.ZodType;
}) =>
  defineTool({
    name: 'test.card',
    group: 'test',
    description: '投影降级测试',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['env.read'],
    ...options,
    // eslint-disable-next-line require-yield
    async *execute() {
      await Promise.resolve();
      throw new Error('本组用例不执行工具');
    },
  });

describe('M3-f 卡片投影的降级', () => {
  it('工具没写投影：拿到的仍是一张通用卡片，不是"没有卡片"', () => {
    const tool = toolWith({});
    const card = projectCallCard(tool, { path: '/w/a.txt' });
    expect(card.kind).toBe('generic');
    expect(card.summary).toContain('/w/a.txt');
  });

  it('🔴 畸形 / 旧版本入参：投影不抛，降级为通用卡片', () => {
    const tool = toolWith({
      presentCall: (input) => ({
        kind: 'terminal',
        summary: input.path,
        command: input.path.toUpperCase(),
      }),
    });
    // 历史事件里的旧形状：字段名换过、被截断、类型对不上
    for (const legacy of [{ file: '/w/a.txt' }, { path: 42 }, null, '截断的碎片', undefined]) {
      const card = projectCallCard(tool, legacy);
      expect(card.kind).toBe('generic');
    }
  });

  it('🔴 投影函数自己抛了：降级，不把异常冒到回放路径上', () => {
    const tool = toolWith({
      presentCall: () => {
        throw new Error('投影里有 bug');
      },
    });
    expect(projectCallCard(tool, { path: '/w/a.txt' }).kind).toBe('generic');
  });

  it('🔴 投影产出的形状不合契约：同样降级，不把没校验过的东西送去渲染', () => {
    const tool = toolWith({
      // 第五种卡片种类不存在；`kind` 是闭集
      presentCall: () => ({ kind: 'flamegraph', summary: 'x' } as unknown as ToolCard),
    });
    expect(projectCallCard(tool, { path: '/w/a.txt' }).kind).toBe('generic');
  });

  it('🔴 没声明 presentationSchema：工具 yield 的展示事实不落库', () => {
    const tool = toolWith({});
    expect(tool.parsePresentation({ anything: 1 })).toBeUndefined();
    const withSchema = toolWith({ presentationSchema: z.strictObject({ n: z.number() }) });
    expect(withSchema.parsePresentation({ n: 1 })).toEqual({ n: 1 });
    // 声明了 schema 但形状对不上（旧版本的落库事实）：同样丢弃，不喂给投影函数
    expect(withSchema.parsePresentation({ n: 'x' })).toBeUndefined();
  });

  it('完成态投影拿到的 presentation 已经过工具自己的 schema', () => {
    const tool = toolWith({
      presentationSchema: z.strictObject({ lines: z.number() }),
      presentResult: () => undefined,
    });
    const seen: unknown[] = [];
    const probe = defineTool({
      name: 'test.probe',
      group: 'test',
      description: '记录投影拿到的东西',
      inputSchema: Input,
      risk: 'safe',
      capabilities: ['env.read'],
      presentationSchema: z.strictObject({ lines: z.number() }),
      presentResult: (_input, outcome) => {
        seen.push(outcome.presentation);
        return undefined;
      },
      // eslint-disable-next-line require-yield
      async *execute() {
        await Promise.resolve();
        throw new Error('不执行');
      },
    });
    projectResultCard(probe, { path: '/w' }, { ok: true, text: '', presentation: { lines: 3 } });
    projectResultCard(probe, { path: '/w' }, { ok: true, text: '', presentation: { lines: 'x' } });
    expect(seen).toEqual([{ lines: 3 }, undefined]);
    // 同一份声明放在普通工具上也一样：schema 决定什么能进投影，不是调用方决定
    expect(tool.parsePresentation({ lines: 3 })).toEqual({ lines: 3 });
  });

  it('工具已经不在注册表里（插件卸载 / 旧会话）：历史照样出卡片', () => {
    const state = sessionWith('已卸载的.工具', { path: '/w/a.txt' }, '结果文本');
    const cards = projectSessionCards(state, new ToolRegistry());
    const only = [...cards.values()][0];
    expect(only?.call?.kind).toBe('generic');
    expect(only?.result?.kind).toBe('generic');
  });

  /*
   * 纯函数硬约束的可执行形态：**同一份已落库状态，投影多少次都必须一模一样**。
   *
   * 反向演练是把投影函数改成会读外部可变量（比如读一次盘），
   * 那时两次投影之间只要外界变了，这条就红——见 M3-f 收官记录里那次演练。
   */
  it('🔴 同一份已落库状态两次投影逐字节一致（实时流与回放不能分叉）', () => {
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'test.pure',
        group: 'test',
        description: '纯投影',
        inputSchema: Input,
        risk: 'safe',
        capabilities: ['env.read'],
        presentCall: (input) => ({
          kind: 'generic',
          title: '读取',
          summary: input.path,
        }),
        // eslint-disable-next-line require-yield
        async *execute() {
          await Promise.resolve();
          throw new Error('不执行');
        },
      }),
    );
    const state = sessionWith('test.pure', { path: '/w/a.txt' }, '结果');
    const first = JSON.stringify([...projectSessionCards(state, tools)]);
    const second = JSON.stringify([...projectSessionCards(state, tools)]);
    expect(second).toBe(first);
  });
});

/** 一条造好的历史：一次 tool_use + 对应的 tool_result */
function sessionWith(name: string, input: unknown, resultText: string): SessionState {
  const callId = newCallId();
  return {
    ...emptySessionState(newSessionId()),
    messages: [
      {
        id: newMessageId(),
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: callId, name, input }],
        ts: 1,
      },
      {
        id: newMessageId(),
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: callId,
            content: [{ type: 'text', text: resultText }],
            isError: false,
          },
        ],
        ts: 2,
      },
    ],
  };
}
