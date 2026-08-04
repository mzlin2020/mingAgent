import { z } from 'zod';

/**
 * 工具对资源的声明，用于并发调度的冲突检测（ADR-0005）。
 *
 * `resources()` 本身是函数，所以留在 kernel 的 `Tool` 接口上；
 * 契约包只定义它的**返回值形状**——因为这个形状要跨进程（插件工具也要能声明）。
 *
 * 声明不了的工具降级为 `exclusive`，宁可串行也不要数据竞争。
 */
export const ResourceClaim = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('path'),
    mode: z.enum(['read', 'write']),
    /** glob，相对工作区根 */
    glob: z.string(),
  }),
  z.object({ kind: z.literal('pty'), sessionId: z.string() }),
  z.object({ kind: z.literal('net'), host: z.string() }),
  /** 兜底：具名的全局互斥量，如 "git-index" */
  z.object({ kind: z.literal('global'), name: z.string() }),
]);
export type ResourceClaim = z.infer<typeof ResourceClaim>;
