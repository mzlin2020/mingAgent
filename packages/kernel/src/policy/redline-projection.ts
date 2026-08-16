import type { Capability, PolicyRule } from '@xm/contracts';

/**
 * 红线的只读投影（ADR-0075）。
 *
 * 给设置页用，不给判定用。判定仍然走 `redLineRules()` 原表。
 * 按 target + why 归并能力：同一条路径挂在三个能力上会显示成一行——
 * 这正是 ADR-0017「红线按目标写、不能按调用方自称在做什么写」要在界面上说出来的那件事。
 *
 * `UpdateSettingsRequest` 不得出现这一组字段。
 */
export interface RedLineView {
  readonly target: string;
  readonly capabilities: readonly Capability[];
  readonly why: string;
}

export function projectRedLines(rules: readonly PolicyRule[]): readonly RedLineView[] {
  const groups = new Map<string, { target: string; why: string; caps: Set<Capability> }>();
  for (const rule of rules) {
    if (!rule.immutable || rule.effect !== 'deny') continue;
    const target = rule.match?.target ?? '*';
    const why = redLineWhy(rule.reason);
    const key = `${target}\0${why}`;
    const cap = rule.capability === '*' ? undefined : rule.capability;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        target,
        why,
        caps: new Set(cap === undefined ? [] : [cap]),
      });
    } else if (cap !== undefined) {
      existing.caps.add(cap);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      target: group.target,
      capabilities: [...group.caps].sort(),
      why: group.why,
    }))
    .sort((a, b) => a.target.localeCompare(b.target) || a.why.localeCompare(b.why));
}

/**
 * 同一条受保护路径会为不同能力生成「修改 / 写入 / 删除 / 直接读取…」前缀不同的 reason。
 * 投影要归并成一行，所以把动词剥掉，留下「保护的是什么」。
 */
function redLineWhy(reason: string): string {
  return reason.replace(/^(?:直接)?(?:读取|写入|删除|修改)/, '').replace(/^。/, '');
}
