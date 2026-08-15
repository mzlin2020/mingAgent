import type { ContentBlock, Message, MessageId } from '@xm/contracts';

/**
 * 工具结果要作为 `tool_result` 块进入 user 消息。并行调用的结果合并到末尾同一条
 * user 消息；判断只依赖已有结构，因此回放仍然确定。
 *
 * ── 为什么不要求末尾那条是“纯 tool_result 桶” ──
 *
 * 回合进行中的 `context.injected`（子 Agent 回传等）会先往末尾那条 user 消息里塞进
 * 非 tool_result 的内容。若因此另起一条消息，就会出现两条相邻 user 消息，且 `tool_result`
 * 不再紧跟发起它的 assistant 消息——Provider 会直接拒绝，而 ScriptedProvider 看不出来。
 * 因此只要末尾是 user 消息就并进去，并把块插在**已有 tool_result 之后、其它内容之前**：
 * 既保住并行调用之间的相对顺序，也保住“tool_result 必须打头”这条 Provider 契约。
 */
export function appendToolResult(
  messages: readonly Message[],
  block: ContentBlock,
  fallbackId: MessageId,
  ts: number,
): readonly Message[] {
  const last = messages.at(-1);
  if (last?.role !== 'user' || last.blocks.length === 0) {
    return [...messages, { id: fallbackId, role: 'user', blocks: [block], ts }];
  }
  let at = 0;
  for (const [index, item] of last.blocks.entries()) {
    if (item.type === 'tool_result') at = index + 1;
  }
  return [
    ...messages.slice(0, -1),
    { ...last, blocks: [...last.blocks.slice(0, at), block, ...last.blocks.slice(at)] },
  ];
}
