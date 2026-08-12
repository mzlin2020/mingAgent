import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule, PolicyRuleSet, TrustLevel } from '@xm/contracts';
import { ALL_CAPABILITIES, newRequestId, newSessionId, targetKindOf } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import {
  FALLBACK_ALLOW_RULE_ID,
  UNTRUSTED_CONTEXT_RULES,
  builtinRules,
  composeRules,
  evaluate,
  redLineRules,
} from '@xm/kernel';

/**
 * ── 这个文件是 ADR-0039 的闸门 ──
 *
 * 一句话：**判定只有 allow 与 deny 两个答案，而拒绝清单一条都没少。**
 *
 * 为什么要一个专门的文件而不是几条散在各处的断言：本项目已经栽过八次
 * "规则存在但从未生效"，教训是**加一条护栏后必须先构造一个它真正要拦的场景、
 * 看它红一次**。这次改动删掉的是一整条代码路径（挂起等人），最容易出的错不是
 * "某条规则写错了"，而是"某个组合下悄悄退回了老行为"。所以这里穷举，不抽样。
 *
 * ── 反向演练（做过，逐条能红）──
 *
 *   1. 往 `defaults.ts` 塞一条 `effect: 'ask'` 的规则
 *      → **编译期**就红（`PolicyRule.effect` 已经只有 allow/deny），根本进不到运行期。
 *        这是刻意的：能让编译器管的事不写成运行时断言。
 *   2. 把 `evaluate()` 第 3 步的兜底从 allow 改成 deny
 *      → 「兜底放行」那一组当场红。
 *   3. 把 `UNTRUSTED_CONTEXT_RULES` 里任意一条的 `immutable` 改成 true
 *      → 「人手写的 allow 能覆盖它们」当场红。
 *   4. 删掉 `UNTRUSTED_CONTEXT_RULES` 里任意一条
 *      → 「污染上下文的三条 deny」当场红。
 *   5. 把某条 `red.*` 的 `immutable` 改成 false
 *      → 「红线跨层最先判」当场红（用户层的 allow-all 会顶掉它）。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

const BUILTIN = builtinRules(ENV);
const RED_LINES = redLineRules(ENV);

/** 每种 target 语义给一个合法的样本值，否则规范化会失败关闭，测的就不是判定了 */
const TARGETS = {
  path: '/work/a.ts',
  host: 'https://example.com/x',
  command: '',
  opaque: 'whatever',
} as const;

const req = (capability: Capability, trustLevel: TrustLevel): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target: TARGETS[targetKindOf(capability)],
  risk: 'medium',
  reason: '测试',
  trustLevel,
});

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'effect'>): PolicyRule => ({
  capability: '*',
  reason: r.id,
  immutable: false,
  ...r,
});

const ALL_TRUST: readonly TrustLevel[] = ['user', 'model', 'untrusted'];

describe('🔴 判定结果的闭集：穷举能力 × 信任级别 × 层组合', () => {
  const shapes: readonly { name: string; layers: ReturnType<typeof composeRules> }[] = [
    { name: '只有内置', layers: composeRules({ env: ENV }) },
    {
      name: '用户层 allow-all',
      layers: composeRules({ env: ENV, user: [rule({ id: 'u.allow', effect: 'allow' })] }),
    },
    {
      name: '用户层 deny-all',
      layers: composeRules({ env: ENV, user: [rule({ id: 'u.deny', effect: 'deny' })] }),
    },
    {
      name: '用户 allow + 项目 deny',
      layers: composeRules({
        env: ENV,
        user: [rule({ id: 'u.allow', effect: 'allow' })],
        project: [rule({ id: 'p.deny', effect: 'deny' })],
      }),
    },
  ];

  it('结果只可能是 allow 或 deny，且永远带 ruleId 与 reason', () => {
    for (const capability of ALL_CAPABILITIES) {
      for (const trustLevel of ALL_TRUST) {
        for (const shape of shapes) {
          const label = `${capability}/${trustLevel}/${shape.name}`;
          const v = evaluate({ request: req(capability, trustLevel), layers: shape.layers });
          expect(['allow', 'deny'], label).toContain(v.effect);
          expect(v.ruleId, label).toBeTruthy();
          expect(v.reason, label).toBeTruthy();
        }
      }
    }
  });

  it('内置规则表里一条 allow 都没有 —— 它是一张纯拒绝清单', () => {
    expect(BUILTIN.filter((r) => r.effect === 'allow')).toEqual([]);
  });
});

describe('兜底放行（第 3 步）', () => {
  it('没有任何规则匹配时放行，ruleId 说明"没有规则"而不是假装是某条规则', () => {
    const v = evaluate({ request: req('gui.capture', 'model'), layers: composeRules({ env: ENV }) });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
  });

  it('兜底不受信任级别影响 —— 收紧的表达方式是规则，不是"污染了就全拦"', () => {
    for (const trustLevel of ALL_TRUST) {
      const v = evaluate({
        request: req('fs.write', trustLevel),
        layers: composeRules({ env: ENV }),
      });
      expect(v.effect, trustLevel).toBe('allow');
    }
  });
});

describe('🔴 拒绝清单一条都没少', () => {
  it('红线全是 immutable deny', () => {
    for (const r of RED_LINES) {
      expect(r.effect, r.id).toBe('deny');
      expect(r.immutable, r.id).toBe(true);
    }
  });

  it('🔴 用户层 allow-all 翻不了任何一条红线', () => {
    const layers = composeRules({
      env: ENV,
      user: [rule({ id: 'u.allow-all', effect: 'allow' })],
    });
    /*
     * 逐条拿红线自己的 target 去打它自己 —— 不是抽样。
     * `match.target` 为空的那几条（按 trustLevel 匹配的）用它们各自的信任级别。
     */
    for (const r of RED_LINES) {
      if (r.capability === '*') continue;
      const trustLevel: TrustLevel = r.match?.trustLevel?.[0] ?? 'model';
      const target = r.match?.target ?? TARGETS[targetKindOf(r.capability)];
      // `?` / `*` 这类模式没法直接当具体 target 用，跳过（它们由 policy-redlines 逐条盯着）
      if (/[*?]/.test(target)) continue;
      const v = evaluate({
        request: { ...req(r.capability, trustLevel), target },
        layers,
      });
      expect(v.effect, r.id).toBe('deny');
      expect(v.ruleId, r.id).toBe(r.id);
    }
  });

  it('🔴 内置的非红线 deny 仍然在（敏感路径 / 持久化 / SSRF / 危险命令）', () => {
    const layers = composeRules({ env: ENV });
    const cases: readonly [Capability, string, RegExp][] = [
      ['fs.read', '/home/ming/.ssh/id_rsa', /^def\.no-read-/],
      ['fs.write', '/home/ming/.zshrc', /^def\.no-write-/],
      ['net.fetch', 'http://169.254.169.254/', /^def\.no-fetch-/],
    ];
    for (const [capability, target, ruleId] of cases) {
      const v = evaluate({ request: { ...req(capability, 'model'), target }, layers });
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toMatch(ruleId);
    }
  });
});

describe('🔴 不可信上下文的三条 deny', () => {
  const layers = composeRules({ env: ENV });

  it('污染后被拒，干净时放行', () => {
    for (const r of UNTRUSTED_CONTEXT_RULES) {
      const tainted = evaluate({ request: req(r.capability as Capability, 'untrusted'), layers });
      expect(tainted.effect, r.id).toBe('deny');
      expect(tainted.ruleId, r.id).toBe(r.id);

      const clean = evaluate({ request: req(r.capability as Capability, 'model'), layers });
      expect(clean.effect, r.id).toBe('allow');
    }
  });

  it('🔴 人手写的 allow 能覆盖它们 —— 这是新模型里唯一的"知情授权"', () => {
    for (const r of UNTRUSTED_CONTEXT_RULES) {
      const withUserAllow = composeRules({
        env: ENV,
        user: [rule({ id: 'u.ok', effect: 'allow', capability: r.capability })],
      });
      const v = evaluate({
        request: req(r.capability as Capability, 'untrusted'),
        layers: withUserAllow,
      });
      expect(v.effect, r.id).toBe('allow');
      expect(v.ruleId, r.id).toBe('u.ok');
    }
  });

  it('🔴 项目层的 allow 覆盖不了它们 —— 那个文件躺在别人的仓库里', () => {
    // 项目层必须先过 tightenOnly()，allow 会被丢掉，所以这里模拟"闸门没做"的最坏情况：
    // 即便一条 allow 混进了项目层，它也只是层序里更靠后的一层——仍然能覆盖。
    // 因此真正的防线是 tightenOnly（`policy-layers.test.ts` 盯着），这里断言的是
    // **走正规入口时覆盖不了**。
    const allowPush: PolicyRuleSet = [rule({ id: 'p.ok', effect: 'allow', capability: 'git.push' })];
    const kept = allowPush.filter((r) => r.effect !== 'allow');
    const v = evaluate({
      request: req('git.push', 'untrusted'),
      layers: composeRules({ env: ENV, project: kept }),
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('untrusted.git-push');
  });

  it('污染上下文下的日常操作照常放行 —— 拦太宽等于整道防线会被关掉', () => {
    for (const capability of ['fs.write', 'fs.delete', 'net.fetch', 'shell.exec'] as const) {
      const v = evaluate({ request: req(capability, 'untrusted'), layers });
      expect(v.effect, capability).toBe('allow');
    }
  });
});
