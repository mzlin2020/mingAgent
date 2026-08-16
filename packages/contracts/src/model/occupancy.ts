import { z } from 'zod';

/**
 * 上下文占用投影（M3.5-f）。
 *
 * ContextBuilder 组装完 `ModelRequest` 之后按段估算：系统提示词 / 工具 schema /
 * 对话，外加这条请求所走模型的窗口容量。它**不是事件**：
 *
 * - 不落库、不占 seq、不进 `reduce()`
 * - 不进模型请求（估算用的是已经组装好的那份，不会再写回去）
 * - 随事件同行，姿势与卡片投影相同（`PushedEvent.occupancy` / `readSession.occupancy`）
 *
 * 把这份形状登记成事件类型，或塞进任意 payload，都是对本段约束的正面违反——
 * `sample-events` 与运行时不变量盯着那两条路。
 */
export const ContextOccupancy = z.strictObject({
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  conversationTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** 路由容量：Provider 声明的 `maxContext`，不是扣掉输出预算之后的硬输入上限 */
  capacityTokens: z.number().int().positive(),
});
export type ContextOccupancy = z.infer<typeof ContextOccupancy>;
