import { z } from 'zod';
import { CallId, RequestId, SessionId } from '../base/ids.js';
import { DisplayHint } from '../tool/display.js';
import { RiskLevel } from '../tool/descriptor.js';
import { Capability } from './capability.js';

/**
 * 上下文信任级别 —— 提示词注入防御的接口（ADR-0003）。
 *
 * 当本轮上下文里混入了不可信内容（网页、MCP 返回、子 Agent 结果），由此发起的
 * 权限请求标记为 `untrusted`，PolicyEngine 对**不可撤销能力子集**自动降级为 ask。
 *
 * M1 只会恒填 `model`——但这个字段现在就必须在契约里：
 * **留位置的成本是零，补位置的成本是改所有调用点。**
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
