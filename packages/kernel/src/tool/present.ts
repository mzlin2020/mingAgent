import type { CallId, ContentBlock, ToolCard, ToolCardPair } from '@xm/contracts';
import { ToolCard as ToolCardSchema } from '@xm/contracts';
import type { SessionState } from '../state/session-state.js';
import type { ToolRegistry } from './registry.js';
import type { RegisteredTool, ToolResultOutcome } from './types.js';

/**
 * 卡片投影（ADR-0058）。
 *
 * ── 为什么这里一定会产出一张卡片 ──
 *
 * 上层（挂起态 / 完成态）拿到的永远是一张卡片，没有"有卡片"和"没卡片"两条路径。
 * 工具没写投影、投影抛了、投影产出的形状不合契约——三种情况全部落到同一张通用卡片上。
 * 渲染层因此只有一条渲染路径，而"新增工具不改渲染层"正是靠这一点成立的：
 * 一个没写任何投影的新工具照样出卡，只是长得朴素。
 *
 * ── 为什么畸形一律降级而不是抛 ──
 *
 * 历史事件里有旧版本参数、有被截断的畸形参数。**展示路径崩掉等于会话打不开**——
 * 小明的整个 UI 就是 `reduce(events)` 的投影，这条比"卡片好不好看"要紧得多。
 */

/** 挂起态卡片：只看调用入参。`search` 没有挂起卡片，那时匹配还不存在 */
export function projectCallCard(tool: RegisteredTool, input: unknown): ToolCard {
  return soften(tool.presentCall(input)) ?? genericCard(tool.descriptor.name, input);
}

/** 完成态卡片：入参 + **已落库的最小事实**。两者都是持久数据，所以实时与回放必然一致 */
export function projectResultCard(
  tool: RegisteredTool,
  input: unknown,
  outcome: ToolResultOutcome,
): ToolCard {
  return (
    soften(tool.presentResult(input, outcome)) ??
    genericCard(tool.descriptor.name, input, outcome)
  );
}

/**
 * 通用兜底卡片：工具名 + 入参一行摘要 + 模型可见文本。
 *
 * 它就是 M3-f 之前那张手写工具卡的内容，只不过现在它是**闭集里的一种卡片**，
 * 而不是渲染层认识的唯一形状。
 */
export function genericCard(
  name: string,
  input: unknown,
  outcome?: ToolResultOutcome,
): ToolCard {
  const summary = `${name} ${summarizeInput(input)}`.trim();
  return {
    kind: 'generic',
    title: name,
    summary: cap(summary, 400),
    ...(outcome === undefined || outcome.text === ''
      ? {}
      : { body: cap(outcome.text, 64 * 1024) }),
  };
}

/**
 * 入参的一行摘要。路径类的最有用，其余退回紧凑 JSON。
 *
 * 入参可能是任何东西（历史事件里的旧版本形状、被截断的碎片），所以 `JSON.stringify`
 * 也要接住——循环引用与 BigInt 都会让它抛。
 */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  const path = (input as Record<string, unknown>).path;
  if (typeof path === 'string') return path;
  try {
    return JSON.stringify(input);
  } catch {
    // 循环引用与 BigInt 都会让它抛。历史事件里的入参什么形状都有可能
    return '';
  }
}

/** 契约校验 + 长度上限。不合形状的卡片一律当作"没有卡片"，由调用方降级 */
const soften = (card: ToolCard | undefined): ToolCard | undefined => {
  if (card === undefined) return undefined;
  const parsed = ToolCardSchema.safeParse(card);
  return parsed.success ? parsed.data : undefined;
};

const cap = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * 一次调用的两张卡片（挂起态 + 完成态）。
 *
 * ── 为什么投影跑在**持有工具表的那一侧**，而不是渲染层 ──
 *
 * 投影函数含在工具定义里，跟 `execute` 一样跨不了进程。让渲染层自己投影就得把
 * 全部工具实现搬进渲染包——那正好是"渲染层零 Node 权限"和"渲染层不认识工具"
 * 两条一起反对的事。所以卡片由主进程投影、随事件一起送到渲染层。
 *
 * 这**不构成第二份状态**（ADR-0015/0021）：卡片是 `(已落库入参, 已落库事实)` 的纯函数，
 * 没有自己的生命周期，也没有任何只存在于内存里的输入。渲染层持有它的时间不超过
 * 持有那条事件的时间，换个进程重算一遍必然一模一样——这正是纯函数硬约束的用处。
 */
export function projectSessionCards(
  state: SessionState,
  tools: ToolRegistry,
): ReadonlyMap<CallId, ToolCardPair> {
  const results = new Map<CallId, Extract<ContentBlock, { type: 'tool_result' }>>();
  for (const message of state.messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }
  const cards = new Map<CallId, ToolCardPair>();
  for (const message of state.messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const tool = tools.get(block.name);
      const result = results.get(block.id);
      cards.set(block.id, {
        call:
          tool === undefined
            ? genericCard(block.name, block.input)
            : projectCallCard(tool, block.input),
        ...(result === undefined
          ? {}
          : {
              result:
                tool === undefined
                  ? genericCard(block.name, block.input, outcomeOf(result))
                  : projectResultCard(tool, block.input, {
                      ...outcomeOf(result),
                      presentation: state.presentations.get(block.id),
                    }),
            }),
      });
    }
  }
  return cards;
}

/**
 * 把已落库的 `tool_result` 块折成完成态投影的输入。
 *
 * 非文本块只留一个占位标记：投影函数拿它没用（图片要走 blob 反查，那是 I/O），
 * 而拼进正文会让卡片正文里出现 `[object Object]` 这类东西。
 */
export function outcomeOf(
  block: Extract<ContentBlock, { type: 'tool_result' }>,
): ToolResultOutcome {
  const text = block.content
    .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
    .join('\n');
  return {
    ok: !block.isError,
    text,
    ...(block.isError ? { errorMessage: text } : {}),
  };
}
