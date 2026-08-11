import { z } from 'zod';
import { Capability } from './capability.js';
import { TrustLevel } from './request.js';

/*
 * ── 这里曾经有 `PermissionTier`（strict / balanced / yolo，ADR-0003）──
 *
 * 档位存在的唯一作用是决定"没有任何规则匹配时要不要问用户"。ADR-0039 之后没有"问用户"
 * 这件事了，兜底只剩一个答案（放行），三档因此退化成同一档——留着等于让调用方在一个
 * 没有区别的枚举上做选择，而这种选择迟早会被当成有意义的。
 *
 * 桌面端那三个模式（请求批准 / 帮我批准 / 完全访问权限，ADR-0030）随之一并删除。
 * 顺带记一句它们的下场：`auto` 与 `full` 从落地第一天起就映射到同一个 `yolo`，
 * 区别只在文案与二次确认——用户用了两天就发现了，这是删掉它们的直接原因。
 */

export const PolicyRule = z.object({
  id: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
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
  /** 红线：任何用户设置、任何层都不可覆盖 */
  immutable: z.boolean().default(false),
});

/*
 * ── 这里曾经有 `grantedAt` 与 `grantedCallId`（ADR-0034 / ADR-0035）──
 *
 * 两个字段都只由 `grantsToRules()` 合成、只在 `session` 层有意义，用来回答一个时间先后
 * 问题："这条授权是用户看着不可信横幅、针对这个具体目标当场点下去的吗？"
 * 答案为是的授权可以穿透注入降级，否则同一个域名会被无限次重复询问。
 *
 * `session` 层的唯一来源是 `SessionState.grants`，而 grants 的唯一来源是用户点击审批卡片
 * 产生的 `permission.decision` 事件。ADR-0039 删掉审批之后，这一层没有来源了，
 * 于是这两个字段也没有了写入者。
 *
 * 新模型里"知情授权"的表达方式换成了**人手写进 `config.json` 的一条持久 allow 规则**：
 * 它同样是人做的决定，同样能盖住污染上下文那三条 deny（它们刻意不是 immutable），
 * 区别只在于它写下的时机是事前而不是事中。
 */
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyRuleSet = z.array(PolicyRule);
export type PolicyRuleSet = z.infer<typeof PolicyRuleSet>;

/**
 * 判定结果 —— **只有两个答案**（ADR-0039）。
 *
 * **必须带 `ruleId`。** 用户问"为什么拦我"，答案要能精确到规则；审计日志同理。
 * 没有 ruleId 的权限系统在出问题时无法排查——这是参考项目完全缺失的一环。
 *
 * ── 为什么这里不再有 `ask` ──
 *
 * `ask` 的语义是"停下来问人"。小明的目标形态是一个基本自主的 agent：判定要么放行、
 * 要么按规则拒绝，中间那条"挂起等人点按钮"的路径整体删除（ADR-0039）。
 *
 * 这不是把闸门关掉——闸门是 deny 那一支，红线与内置拒绝清单一条没少，反而因为
 * 不再有"用户会顺手点允许"这个出口而变得更硬。真实的代价只有一处，写在 ADR-0039
 * 的「后果」里：不可信上下文下的非严重操作从"降级成一次提问"变成静默放行。
 *
 * **这一支删掉是编译期护栏**：想再加回"问一次"的路径，会在这里先撞上类型错误，
 * 而不是先长出一个悄悄挂起的分支。本项目栽过八次"规则存在但从未生效"，
 * 能让编译器管的就不写成约定。
 */
export const PolicyVerdict = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('allow'), ruleId: z.string(), reason: z.string() }),
  z.object({ effect: z.literal('deny'), ruleId: z.string(), reason: z.string() }),
]);
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;
