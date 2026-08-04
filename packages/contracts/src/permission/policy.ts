import { z } from 'zod';
import { RiskLevel } from '../tool/descriptor.js';
import { Capability } from './capability.js';
import { TrustLevel } from './request.js';

/**
 * 权限档位（ADR-0003）。决定"没有任何规则匹配"时的兜底行为。
 * 红线（immutable 规则）不受档位影响，YOLO 也一样。
 */
export const PermissionTier = z.enum(['strict', 'balanced', 'yolo']);
export type PermissionTier = z.infer<typeof PermissionTier>;

export const PolicyRule = z.object({
  id: z.string().min(1),
  effect: z.enum(['allow', 'ask', 'deny']),
  capability: z.union([Capability, z.literal('*')]),
  match: z
    .object({
      /** glob；不写表示匹配该能力的一切目标 */
      target: z.string().optional(),
      executor: z.enum(['local', 'container', 'remote']).optional(),
      trustLevel: z.array(TrustLevel).optional(),
    })
    .optional(),
  /** 展示给用户的理由。Verdict 会原样带出去，所以要写人话 */
  reason: z.string().min(1),
  /** 红线：任何档位、任何用户设置都不可覆盖 */
  immutable: z.boolean().default(false),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyRuleSet = z.array(PolicyRule);
export type PolicyRuleSet = z.infer<typeof PolicyRuleSet>;

/**
 * 判定结果。
 *
 * **必须带 `ruleId`。** 用户问"为什么拦我"，答案要能精确到规则；审计日志同理。
 * 没有 ruleId 的权限系统在出问题时无法排查——这是参考项目完全缺失的一环。
 */
export const PolicyVerdict = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('allow'), ruleId: z.string(), reason: z.string() }),
  z.object({
    effect: z.literal('ask'),
    ruleId: z.string(),
    reason: z.string(),
    risk: RiskLevel,
  }),
  z.object({ effect: z.literal('deny'), ruleId: z.string(), reason: z.string() }),
]);
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;
