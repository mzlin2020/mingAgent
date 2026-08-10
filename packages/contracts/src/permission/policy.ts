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
      /**
       * 按解析出的 IP 地址段匹配（M1-d，web.fetch 的 SSRF 判定）。只对 `host` kind
       * 的能力有意义——构造期由 `assertRules()` 强制。
       *
       * 故意是**闭集字面量**，不是让用户在配置里写任意 CIDR 字符串：SSRF 防护不需要
       * 用户可配置网段（用户要放行的是"这一个具体地址"，走 `target` 字面量 allow），
       * 这与 `Capability` 用闭集而不是自由字符串防止插件自造能力名是同一个理由。
       * `172.16.0.0/12` 这类不对齐在点分段边界的网段，极简 glob 表达不了，
       * 需要专门的位运算判定（见 `policy/ip-range.ts`），因此单独开一个匹配维度，
       * 不硬塞进 `target` 的 glob 里。
       */
      ipRange: z.enum(['private']).optional(),
    })
    .optional(),
  /** 展示给用户的理由。Verdict 会原样带出去，所以要写人话 */
  reason: z.string().min(1),
  /** 红线：任何档位、任何用户设置都不可覆盖 */
  immutable: z.boolean().default(false),
  /**
   * 这条规则背后那个决定是**什么时候由用户当场做出的**（epoch ms，ADR-0034）。
   *
   * **只由 `grantsToRules()` 合成，只在 `session` 层有意义。** 它存在的唯一用途是回答
   * 一个时间先后问题：这次授权是在上下文被不可信内容污染**之后**做出的吗？是，才说明
   * 用户是看着那条不可信横幅、针对这个具体目标点下去的——那样的决定可以穿透注入降级
   * （否则同一个域名会被无限次重复询问）；不是，那条授权就没有回答过这个问题。
   *
   * 在配置文件里手写它没有任何效果：`evaluate()` 只在命中层是 `session` 时才读它，
   * 而 `session` 层的唯一来源是 `SessionState.grants`，那又只来自 `permission.decision`
   * 事件。用户级/项目级配置永远进不了那一层——这不是靠校验挡住的，是靠层的来源本身。
   */
  grantedAt: z.number().optional(),
  /**
   * 这条规则背后那个决定是**在哪一次工具调用里**做出的（ADR-0035）。
   *
   * 与 `grantedAt` 同样只由 `grantsToRules()` 合成、只在 `session` 层有意义，
   * 补的是 `grantedAt` 那条时间比较的一个边界：污点标在 `tool.start`，而放行这次调用的
   * 授权记在更早的 `permission.decision` 上，于是**批准了这次污染本身的那条授权**
   * 反而 `grantedAt < untrustedSince`，用户刚点过的第一个域名下一次还要再问一遍。
   *
   * 拿 callId 对齐就没有这个缝：授权与污染出自同一次调用，说明用户点"允许"时
   * 要发生的正是这次污染，再问一遍问的是同一个问题。而会话早期对别的目标的旧授权
   * 属于**另一次**调用，callId 对不上，仍然穿不透（ADR-0034 条件 ③ 要挡的就是它）。
   */
  grantedCallId: z.string().optional(),
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
