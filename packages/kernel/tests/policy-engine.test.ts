import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule, PolicyRuleSet, TrustLevel } from '@xm/contracts';
import { ALL_CAPABILITIES, IRREVERSIBLE_CAPABILITIES, newRequestId, newSessionId } from '@xm/contracts';
import {
  BUILTIN_RULES,
  INJECTION_DOWNGRADE_RULE_ID,
  RED_LINE_RULES,
  TIER_FALLBACK_RULE_ID,
  composeRules,
  evaluate,
  globMatch,
} from '@xm/kernel';

const req = (
  capability: Capability,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target: '/work/a.ts',
  risk: 'medium',
  reason: '测试',
  trustLevel: 'model',
  ...overrides,
});

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'effect'>): PolicyRule => ({
  capability: '*',
  reason: r.id,
  immutable: false,
  ...r,
});

describe('PolicyEngine：优先级判定表', () => {
  const table: readonly {
    name: string;
    rules: PolicyRuleSet;
    expect: 'allow' | 'ask' | 'deny';
    ruleId?: string;
  }[] = [
    {
      name: '无规则 + 平衡档 + 非 safe → ask（档位兜底）',
      rules: [],
      expect: 'ask',
      ruleId: TIER_FALLBACK_RULE_ID,
    },
    {
      name: 'allow 单独存在 → allow',
      rules: [rule({ id: 'a', effect: 'allow' })],
      expect: 'allow',
      ruleId: 'a',
    },
    {
      name: 'ask 压过 allow（无论定义顺序）',
      rules: [rule({ id: 'k', effect: 'ask' }), rule({ id: 'a', effect: 'allow' })],
      expect: 'ask',
      ruleId: 'k',
    },
    {
      name: 'deny 压过 ask 与 allow',
      rules: [
        rule({ id: 'a', effect: 'allow' }),
        rule({ id: 'd', effect: 'deny' }),
        rule({ id: 'k', effect: 'ask' }),
      ],
      expect: 'deny',
      ruleId: 'd',
    },
    {
      name: '同优先级内后定义者胜（项目配置覆盖用户配置）',
      rules: [rule({ id: 'a1', effect: 'allow' }), rule({ id: 'a2', effect: 'allow' })],
      expect: 'allow',
      ruleId: 'a2',
    },
    {
      name: 'immutable deny 压过一切',
      rules: [
        rule({ id: 'red', effect: 'deny', immutable: true }),
        rule({ id: 'a', effect: 'allow' }),
      ],
      expect: 'deny',
      ruleId: 'red',
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const verdict = evaluate({
        request: req('fs.write'),
        rules: row.rules,
        tier: 'balanced',
      });
      expect(verdict.effect).toBe(row.expect);
      if (row.ruleId !== undefined) expect(verdict.ruleId).toBe(row.ruleId);
    });
  }

  it('每个 Verdict 都带 ruleId 与 reason —— 用户问"为什么拦我"必须答得出', () => {
    for (const capability of ALL_CAPABILITIES) {
      for (const tier of ['strict', 'balanced', 'yolo'] as const) {
        const v = evaluate({ request: req(capability), rules: BUILTIN_RULES, tier });
        expect(v.ruleId, `${capability}/${tier}`).toBeTruthy();
        expect(v.reason, `${capability}/${tier}`).toBeTruthy();
      }
    }
  });
});

describe('PolicyEngine：档位兜底', () => {
  it('平衡档：safe 放行，其余询问', () => {
    expect(evaluate({ request: req('net.listen', { risk: 'safe' }), rules: [], tier: 'balanced' }).effect).toBe('allow');
    expect(evaluate({ request: req('net.listen', { risk: 'low' }), rules: [], tier: 'balanced' }).effect).toBe('ask');
  });

  it('严格档：一律询问，safe 也不例外', () => {
    expect(evaluate({ request: req('fs.read', { risk: 'safe' }), rules: [], tier: 'strict' }).effect).toBe('ask');
  });

  it('YOLO 档：默认放行', () => {
    expect(evaluate({ request: req('shell.exec'), rules: [], tier: 'yolo' }).effect).toBe('allow');
  });

  it('🔴 YOLO 也拦不住红线', () => {
    const v = evaluate({
      request: req('fs.delete', { target: '/' }),
      rules: BUILTIN_RULES,
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.fs-delete-filesystem-root');
  });

  it('🔴 用户规则覆盖不了红线', () => {
    const userAllowsEverything: PolicyRuleSet = [
      rule({ id: 'user.allow-all', effect: 'allow', capability: '*' }),
    ];
    const v = evaluate({
      request: req('gui.input', { trustLevel: 'untrusted' }),
      rules: composeRules(userAllowsEverything),
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.gui-input-untrusted');
  });
});

describe('PolicyEngine：提示词注入降级', () => {
  it('untrusted + 不可撤销能力 + 本来 allow → 降级为 ask', () => {
    for (const capability of IRREVERSIBLE_CAPABILITIES) {
      const v = evaluate({
        request: req(capability, { trustLevel: 'untrusted' }),
        rules: [rule({ id: 'a', effect: 'allow' })],
        tier: 'balanced',
      });
      // 红线已经 deny 的那几个不参与降级判断
      if (v.effect === 'deny') continue;
      expect(v.effect, capability).toBe('ask');
      expect(v.ruleId, capability).toBe(INJECTION_DOWNGRADE_RULE_ID);
    }
  });

  it('untrusted 但能力可撤销 → 不降级', () => {
    const v = evaluate({
      request: req('fs.write', { trustLevel: 'untrusted' }),
      rules: [rule({ id: 'a', effect: 'allow' })],
      tier: 'balanced',
    });
    expect(v.effect).toBe('allow');
  });

  it('trustLevel=model 或 user 时不降级 —— 全局收紧会被用户整体关掉', () => {
    for (const trustLevel of ['user', 'model'] satisfies TrustLevel[]) {
      const v = evaluate({
        request: req('net.fetch', { trustLevel }),
        rules: [rule({ id: 'a', effect: 'allow' })],
        tier: 'balanced',
      });
      expect(v.effect, trustLevel).toBe('allow');
    }
  });

  it('降级只把 allow 变 ask，不会把 deny 变松', () => {
    const v = evaluate({
      request: req('net.fetch', { trustLevel: 'untrusted' }),
      rules: [rule({ id: 'd', effect: 'deny' })],
      tier: 'balanced',
    });
    expect(v.effect).toBe('deny');
  });
});

describe('PolicyEngine：匹配条件', () => {
  it('capability 精确匹配，`*` 匹配全部', () => {
    const rules = [rule({ id: 'only-read', effect: 'allow', capability: 'fs.read' })];
    expect(evaluate({ request: req('fs.read'), rules, tier: 'balanced' }).ruleId).toBe('only-read');
    expect(evaluate({ request: req('fs.write'), rules, tier: 'balanced' }).ruleId).toBe(
      TIER_FALLBACK_RULE_ID,
    );
  });

  it('target glob 匹配', () => {
    const rules = [
      rule({ id: 'src-only', effect: 'allow', capability: 'fs.write', match: { target: '/work/src/**' } }),
    ];
    expect(
      evaluate({ request: req('fs.write', { target: '/work/src/a/b.ts' }), rules, tier: 'balanced' })
        .ruleId,
    ).toBe('src-only');
    expect(
      evaluate({ request: req('fs.write', { target: '/work/other.ts' }), rules, tier: 'balanced' })
        .ruleId,
    ).toBe(TIER_FALLBACK_RULE_ID);
  });

  it('executor 匹配，默认按 local 判定', () => {
    const rules = [
      rule({ id: 'container-only', effect: 'allow', match: { executor: 'container' } }),
    ];
    expect(evaluate({ request: req('shell.exec'), rules, tier: 'balanced' }).ruleId).toBe(
      TIER_FALLBACK_RULE_ID,
    );
    expect(
      evaluate({ request: req('shell.exec'), rules, tier: 'balanced', executor: 'container' })
        .ruleId,
    ).toBe('container-only');
  });

  it('trustLevel 匹配', () => {
    const rules = [rule({ id: 'trusted-only', effect: 'allow', match: { trustLevel: ['user'] } })];
    expect(
      evaluate({ request: req('fs.write', { trustLevel: 'user' }), rules, tier: 'balanced' }).ruleId,
    ).toBe('trusted-only');
    expect(
      evaluate({ request: req('fs.write', { trustLevel: 'model' }), rules, tier: 'balanced' }).ruleId,
    ).toBe(TIER_FALLBACK_RULE_ID);
  });
});

describe('globMatch：安全边界上的匹配语义必须简单可推理', () => {
  it('* 不跨 /，** 跨 /', () => {
    expect(globMatch('/a/*', '/a/b')).toBe(true);
    expect(globMatch('/a/*', '/a/b/c')).toBe(false);
    expect(globMatch('/a/**', '/a/b/c')).toBe(true);
  });

  it('? 匹配单个非 / 字符', () => {
    expect(globMatch('/a?c', '/abc')).toBe(true);
    expect(globMatch('/a?c', '/a/c')).toBe(false);
  });

  it('正则元字符被转义，不会意外放大匹配范围', () => {
    expect(globMatch('/a.txt', '/aXtxt')).toBe(false);
    expect(globMatch('/a.txt', '/a.txt')).toBe(true);
    expect(globMatch('/a+b', '/a+b')).toBe(true);
  });

  it('全串匹配，不是子串匹配', () => {
    expect(globMatch('/etc', '/etc/passwd')).toBe(false);
  });
});

describe('红线清单', () => {
  it('全部标记为 immutable', () => {
    for (const r of RED_LINE_RULES) {
      expect(r.immutable, r.id).toBe(true);
      expect(r.effect, r.id).toBe('deny');
    }
  });

  it('数量保持克制 —— 红线一多，用户就会去找绕过的办法', () => {
    expect(RED_LINE_RULES.length).toBeLessThanOrEqual(8);
  });

  it('包含"不许改权限模块自身"这条', () => {
    const r = RED_LINE_RULES.find((x) => x.id === 'red.self-modify-policy');
    expect(r).toBeDefined();
    expect(globMatch(r!.match!.target!, '/repo/packages/kernel/src/policy/defaults.ts')).toBe(true);
  });
});
