import type { ContentBlock, Message, MessageId } from '@xm/contracts';

/**
 * 工具结果要作为 `tool_result` 块进入 user 消息。并行调用的结果合并到末尾同一条
 * 纯工具结果消息；判断只依赖已有结构，因此回放仍然确定。
 */
export function appendToolResult(
  messages: readonly Message[],
  block: ContentBlock,
  fallbackId: MessageId,
  ts: number,
): readonly Message[] {
  const last = messages.at(-1);
  const isToolResultBucket =
    last?.role === 'user' &&
    last.blocks.length > 0 &&
    last.blocks.every((item) => item.type === 'tool_result');

  if (isToolResultBucket) {
    return [...messages.slice(0, -1), { ...last, blocks: [...last.blocks, block] }];
  }
  return [...messages, { id: fallbackId, role: 'user', blocks: [block], ts }];
}
