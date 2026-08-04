import { z } from 'zod';

/**
 * 错误码词表（闭集）。
 *
 * `policy_denied` / `user_rejected` / `permission_denied` **必须分开**：
 * 三者的用户处置完全不同——改策略、重新审批、改系统权限。参考项目把它们全揉成
 * 一个字符串，结果 UI 无法给出正确的下一步引导，用户只能看到"失败了"。
 */
export const ErrorCode = z.enum([
  'invalid_input', // schema 校验失败（含模型幻觉参数）
  'not_found',
  'policy_denied', // 策略闸门拒绝
  'user_rejected', // 用户在审批弹窗点了拒绝
  'permission_denied', // 操作系统层面拒绝（EACCES 等）
  'aborted', // 用户主动停止
  'timeout',
  'executor_failed', // 执行器层面失败（容器起不来、SSH 断了）
  'provider_error', // 模型侧错误
  'rate_limited',
  'context_overflow',
  'tool_not_found',
  'unsupported', // 当前平台/执行器不支持该能力
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * 结构化错误。
 *
 * **错误不跨越主循环抛出**：工具失败一律转成 `tool_result{ isError: true }` 回灌给模型——
 * 模型有机会换个方式重试，这是 Agent 能力的重要来源。只有内核自身的不变量被破坏才 throw。
 */
export const XmError = z.object({
  code: ErrorCode,
  /** 面向用户，中文 */
  message: z.string(),
  retryable: z.boolean(),
  /** 结构化上下文，用于排查；注意入库前要过 redact() */
  detail: z.record(z.string(), z.unknown()).optional(),
  /** 原始错误的字符串化链，最外层在前 */
  causeChain: z.array(z.string()).optional(),
});
export type XmError = z.infer<typeof XmError>;

/** 默认可重试的错误码。判断错了不致命——调用方可以显式覆盖。 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'timeout',
  'rate_limited',
  'provider_error',
  'executor_failed',
]);

/** 构造错误的便捷函数。纯数据，不 throw。 */
export const xmError = (
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; detail?: Record<string, unknown>; causeChain?: string[] } = {},
): XmError => ({
  code,
  message,
  retryable: opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
  ...(opts.detail === undefined ? {} : { detail: opts.detail }),
  ...(opts.causeChain === undefined ? {} : { causeChain: opts.causeChain }),
});
