import type { ContextOccupancy, ModelRequest } from '@xm/contracts';

const encoder = new TextEncoder();

/**
 * 上下文占用投影（M3.5-f）。
 *
 * 与卡片投影同一姿势：纯函数，入参是已经组装好的 `ModelRequest`，
 * 不读会话状态、不做 I/O、不把结果写回请求。估算器与压缩路径共用
 * UTF-8 / 3（ADR-0048）——偏差允许，但方向必须稳定：这份估算相对
 * 英文 tokenizer 偏保守（偏高），不能一会儿高估一会儿低估。
 *
 * `countedTotal` 是 `countRequestTokens` 的结果（有 Provider 精确计数就用它）。
 * 三段按估算比例摊到这个总数上，环上的合计与压缩判定看到的是同一个数字。
 */
export function projectContextOccupancy(
  request: ModelRequest,
  capacityTokens: number,
  countedTotal?: number,
): ContextOccupancy {
  const system = estimateTextTokens(JSON.stringify(request.system));
  const tools = estimateTextTokens(JSON.stringify(request.tools ?? []));
  const conversation = estimateTextTokens(JSON.stringify(request.messages));
  const estimated = system + tools + conversation;
  const total = countedTotal ?? estimated;
  if (estimated <= 0) {
    return {
      systemTokens: 0,
      toolsTokens: 0,
      conversationTokens: 0,
      totalTokens: total,
      capacityTokens,
    };
  }
  const scale = total / estimated;
  const systemTokens = Math.floor(system * scale);
  const toolsTokens = Math.floor(tools * scale);
  return {
    systemTokens,
    toolsTokens,
    conversationTokens: total - systemTokens - toolsTokens,
    totalTokens: total,
    capacityTokens,
  };
}

export function estimateRequestTokens(request: ModelRequest): number {
  return estimateTextTokens(JSON.stringify(request)) + 32;
}

export function estimateMessagesTokens(messages: ModelRequest['messages']): number {
  return estimateTextTokens(JSON.stringify(messages)) + messages.length * 8;
}

export function estimateTextTokens(text: string): number {
  // UTF-8 / 3 对中文约为一字一 token，对英文比常见的 /4 更保守。
  return Math.max(1, Math.ceil(encoder.encode(text).byteLength / 3));
}

/** payload 长得像占用投影——写入路径用它抓住"塞进事件流"的那条路 */
export function payloadLooksLikeOccupancy(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const row = payload as Record<string, unknown>;
  return (
    typeof row.systemTokens === 'number' &&
    typeof row.toolsTokens === 'number' &&
    typeof row.conversationTokens === 'number' &&
    typeof row.capacityTokens === 'number'
  );
}
