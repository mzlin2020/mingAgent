import type { PolicyRule, PolicyRuleSet } from '@xm/contracts';
import type { PermissionGrant } from '../state/session-state.js';
import { normalizeTarget } from './normalize.js';

/**
 * 规则层的构造 —— 三件事：**项目层只能收紧**、**授权合成规则**、**字面路径要转义**。
 *
 * `engine.ts` 只负责"给定若干层，判出结果"。层是怎么来的、哪一层可以放松哪一层不行，
 * 全在这个文件里。分开是因为前者是纯判定、要能被穷举测试，后者是一组安全取舍、
 * 每一条都要说得出理由。
 */

// ── 项目层只能收紧 ──────────────────────────────────────────────

export interface TightenOutcome {
  readonly rules: PolicyRuleSet;
  /** 被丢弃的规则 id。调用方必须把它变成一条用户可见的 notice，不许静默 */
  readonly dropped: readonly string[];
}

/**
 * 丢掉一层里所有**放松**权限的规则，只保留 deny / ask。
 *
 * 用在**项目级** `.xiaoming/config.json` 上，理由具体到几乎是一条攻击路径：
 *
 *   · 那个文件躺在用户 clone 下来的仓库里，作者不是用户；
 *   · 小明自己有 `fs.write`，模型完全可以在干活的过程中把它写出来；
 *   · 而层序里项目层排在用户层之后——它要是能放松，就等于"仓库里的一个文件
 *     可以撤销用户的设置"。
 *
 * 这与 `SESSION_FORBIDDEN_CONFIG_PATHS`（会话补丁不许碰 permission / providers）
 * 是同一条纪律的同一个形状：**能被下游写出来的东西，只许收紧，不许放松。**
 *
 * 收紧方向留着是有用的：一个仓库说"这里别乱写"是合理且无害的表达。
 */
export function tightenOnly(rules: PolicyRuleSet): TightenOutcome {
  const kept: PolicyRule[] = [];
  const dropped: string[] = [];
  for (const r of rules) {
    if (r.effect === 'allow') dropped.push(r.id);
    else kept.push(r);
  }
  return { rules: kept, dropped };
}

// ── 授权 → 规则 ────────────────────────────────────────────────

/** 会话授权层的规则 id 前缀。UI 据此把 verdict 解释成"你在本会话授权过" */
export const GRANT_RULE_PREFIX = 'grant.';

/**
 * 把用户当场做出的、**范围超过单次**的决定（scope = session / always）变成规则。
 *
 * `SessionState.grants` 从 M0 起就在 `reduce` 里算着了，一直没有任何人读它——
 * 于是"本会话都允许"这个选项即便点了，下一次调用照样弹框。这个函数是它的读取端。
 *
 * 四个细节，每个都是错了就放大权限的那种：
 *
 * 〇、**先规范化，再转义。** 授权的 target 是从 `PermissionRequest` 里原样带出来的，
 *     而判定时 `evaluate()` 会把请求的 target 规范化之后再比。两边坐标系不一致，
 *     合成出来的规则就永远匹配不上——Windows 上尤其明显：授权存的是
 *     `C:\work\a.md`，判定比的是 `C:/work/a.md`，于是"本会话都允许"点了等于没点
 *     （三平台 CI 实测，M1-c 补记）。规范化失败的直接丢弃（**失败关闭**）：
 *     一条判定时必然 deny 的 target，合成出规则来只会让人以为授权生效了。
 * 一、**target 要转义。** 授权针对的是一个具体的目标（一个路径、一个 host），
 *     不是一个模式。见 `escapeGlobPattern`。
 * 二、**`always` 也进会话层。** 它同时会被写进用户级配置文件，但那要下次启动
 *     才读得到——不进会话层的话，用户点完"永久允许"，紧接着的下一次调用还会再问一遍。
 * 三、**deny 的授权照样合成。** 用户点"本会话都拒绝"和点"本会话都允许"一样是决定，
 *     只合成 allow 就等于回放出来的会话比当时更松。
 *
 * 规范化不了的直接跳过——**失败关闭**：那一条授权不生效，用户下次还会被问一遍，
 * 而不是拿到一条建立在判不了的 target 上的规则。
 */
export const grantsToRules = (grants: readonly PermissionGrant[]): PolicyRuleSet =>
  grants.flatMap((g) => {
    const normalized = normalizeTarget(g.capability, g.target);
    if (!normalized.ok) return [];
    return [grantRule(g, normalized.value)];
  });

const grantRule = (g: PermissionGrant, target: string): PolicyRule => ({
  id: `${GRANT_RULE_PREFIX}${g.scope}.${g.requestId}`,
  effect: g.effect,
  capability: g.capability,
  match: { target: escapeGlobPattern(target) },
  reason:
    g.effect === 'allow'
      ? `你在本会话${g.scope === 'always' ? '选择了永久允许' : '允许过这个操作'}`
      : `你在本会话${g.scope === 'always' ? '选择了永久拒绝' : '拒绝过这个操作'}`,
  immutable: false,
});

/**
 * 把一个**字面**目标变成只匹配它自己的 glob。
 *
 * `PolicyRule.match.target` 是模式，而授权的 target 是从 `PermissionRequest` 里
 * 原样带出来的一个具体值。两者形状相同、含义不同，中间必须有这一步——
 * POSIX 上 `a*b`、`log?.txt` 都是合法文件名，不转义的话，
 * 一次"允许写 /work/a*b"的授权会连 `/work/aXb`、`/work/anything-b` 一起放行。
 *
 * 授权是会被写进用户配置、长期留着的，所以这个放大不是一次性的。
 */
export const escapeGlobPattern = (literal: string): string =>
  literal.replace(/[\\*?]/g, '\\$&');

/*
 * ── 这里曾经有一个 `grantable()` ──
 *
 * 它挡的是命令类能力：ADR-0020 决策三说命令行 target 没有规范化契约，
 * 于是这类操作的"本会话都允许"干脆不提供——宁可每次都问，也不要给一个错的承诺。
 *
 * ADR-0026 把契约补上之后，它没有存在的理由了，所以整个删掉而不是留一个恒真的函数。
 * 留下来的那道防线是上面的**失败关闭**：规范化不了的授权一律丢弃。它比一份名单可靠——
 * 名单要有人记得维护，而失败关闭是规范化本身的副产品。
 *
 * 顺带说清楚为什么 `opaque` 仍然可以授权（`git.push origin` 这类）：
 * opaque 上的**放松**方向失效时是"下次又问了一遍"，落在安全的那一侧。
 * 危险的是在 opaque 上写 deny 并以为它挡住了，而那件事由 `assertRules` 的红线闸门管。
 */
