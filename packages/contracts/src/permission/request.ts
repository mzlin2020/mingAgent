import { z } from 'zod';
import { CallId, RequestId, SessionId } from '../base/ids.js';
import { DisplayHint } from '../tool/display.js';
import { RiskLevel } from '../tool/descriptor.js';
import { Capability } from './capability.js';

/**
 * 上下文信任级别 —— 提示词注入防御的接口（ADR-0003）。
 *
 * 当会话上下文里混入不可信内容（网页、终端回显、截图、未来 MCP 返回或子 Agent 污点），
 * 后续权限请求标记为 `untrusted`。PolicyEngine 不做 ask 降级；它用声明式 deny 规则拒绝
 * `git.push` / `package.install` / `system.settings` 以及三条 immutable 严重项。
 * 信任级别由事件流计算，不由调用方自由填写。
 */
export const TrustLevel = z.enum(['user', 'model', 'untrusted']);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const PermissionRequest = z.object({
  requestId: RequestId,
  sessionId: SessionId,
  callId: CallId.optional(),
  capability: Capability,
  /** 路径 / host / 命令行，含义随能力而定 */
  target: z.string(),
  risk: RiskLevel,
  /** 给用户看：为什么要这个权限。空字符串不可接受 */
  reason: z.string().min(1),
  /** 高风险操作的预览，比如将要执行的 diff */
  preview: DisplayHint.optional(),
  trustLevel: TrustLevel,
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionDecision = z.object({
  requestId: RequestId,
  effect: z.enum(['allow', 'deny']),
  /** `always` 会写进用户级策略文件，因此需要显式的规则来源 */
  scope: z.enum(['once', 'session', 'always']),
  by: z.enum(['policy', 'user']),
  ruleId: z.string().optional(),
});
export type PermissionDecision = z.infer<typeof PermissionDecision>;
