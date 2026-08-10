import type { PolicyRuleSet } from '@xm/contracts';

/**
 * 规则层的**类型**声明。
 *
 * 单独成文件，是为了拆开一个真实的循环依赖：`engine.ts`（求值）与
 * `untrusted-downgrade.ts`（注入降级）都需要"层"这个概念——前者按层求值，
 * 后者要判断定案的那条规则来自哪一层（只有 `session` 层的授权算知情，ADR-0034）。
 * 谁 import 谁都会成环，而 depcruise 的禁循环规则会当场拦下（实测）。
 *
 * 类型放在被两边共同依赖的叶子模块上，是这类环唯一不靠"反正 import type 会被擦掉"
 * 蒙混过关的解法——那种写法在类型层面确实无环，但依赖图上仍然是环，
 * 下一个人往里加一行值导入就真的成环了，而且不会有任何东西提醒他。
 */

/**
 * 规则的来源层。**顺序即优先级**，见 `evaluate()` 的求值顺序说明。
 *
 * 层名不只是标签：`project` 层被限制为只能收紧（`layers.ts` 的 `tightenOnly`），
 * `session` 层由用户当场的审批决定合成（`grantsToRules`）——而后者正是
 * "知情授权"这个概念的全部依据（`untrusted-downgrade.ts`）。
 */
export type RuleLayerId = 'builtin' | 'user' | 'project' | 'session';

export interface RuleLayer {
  readonly id: RuleLayerId;
  readonly rules: PolicyRuleSet;
}
