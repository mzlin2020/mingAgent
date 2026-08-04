import { z } from 'zod';

/**
 * Token 用量。
 *
 * **成本不在 Provider 里算。** 这里只有 token 数，`costUsd` 由 CostAccountant
 * 查价格表得出。价格会变、会有折扣、不同账户不同价——硬编码进适配器就等于
 * 每次调价都要改代码发版。价格表是配置。
 */
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** prompt cache 命中读取的 token，通常按折扣价计费 */
  cacheReadTokens: z.number().int().nonnegative().default(0),
  /** 写入缓存的 token，通常按溢价计费 */
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** 推理/思考 token（若模型单独计量） */
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const StopReason = z.enum([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'aborted',
  'error',
]);
export type StopReason = z.infer<typeof StopReason>;

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  ...(a.reasoningTokens === undefined && b.reasoningTokens === undefined
    ? {}
    : { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }),
});
