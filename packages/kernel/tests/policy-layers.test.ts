import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PermissionGrant, PolicyEnv, RuleLayer } from '@xm/kernel';
import {
  builtinRules,
  composeRules,
  escapeGlobPattern,
  evaluate,
  globMatch,
  grantsToRules,
  tightenOnly,
} from '@xm/kernel';

/**
 * ── 层间语义（ADR-0023）──
 *
 * 层内语义（deny > ask > allow、后定义者胜）在 `policy-engine.test.ts` 里考，
 * 这里考的是**层与层之间**：后一层压过前一层，而红线不参与层序。
 *
 * 这套语义的由来是一个具体的失效：上一版把所有规则拍平，优先级与定义顺序无关，
 * 于是任何 allow 都压不过内置的 ask——`fs.write` / `fs.delete` / `shell.exec` /
 * `git.push` / `net.fetch` 默认全是 ask，**「永久授权」在那个引擎里根本表达不出来**，
 * `Config.permission.rules` 里的 allow 条目对所有值得授权的能力一条都不生效。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

const req = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'medium',
  reason: '测试',
  trustLevel: 'model',
});

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'effect'>): PolicyRule => ({
  capability: '*',
  reason: r.id,
  immutable: false,
  ...r,
});

const layer = (id: RuleLayer['id'], rules: PolicyRuleSet): RuleLayer => ({ id, rules });

describe('层序：后一层胜', () => {
  it('🔴 后一层的 allow 压过前一层的 ask —— 「永久授权」全靠这一条', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('builtin', builtinRules(ENV)), // def.fs-write 是 ask
        layer('user', [
          rule({ id: 'user.allow-work', effect: 'allow', capability: 'fs.write', match: { target: '/work/**' } }),
        ]),
      ],
      tier: 'balanced',
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('user.allow-work');
  });

  it('同一层内 ask 仍然压过 allow —— 层内语义一个字没变', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [
          rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' }),
          rule({ id: 'u.ask', effect: 'ask', capability: 'fs.write' }),
        ]),
      ],
      tier: 'balanced',
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe('u.ask');
  });

  it('后一层的 deny 压过前一层的 allow', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' })]),
        layer('project', [rule({ id: 'p.deny', effect: 'deny', capability: 'fs.write' })]),
      ],
      tier: 'balanced',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('p.deny');
  });

  it('后一层的 allow 也能放松前一层的**非红线** deny —— 用户可覆盖就是这个意思', () => {
    const v = evaluate({
      request: req('fs.read', '/work/a.ts'),
      layers: [
        layer('builtin', [rule({ id: 'b.deny', effect: 'deny', capability: 'fs.read' })]),
        layer('user', [rule({ id: 'u.allow', effect: 'allow', capability: 'fs.read' })]),
      ],
      tier: 'balanced',
    });
    expect(v.effect).toBe('allow');
  });

  it('没有匹配的层被跳过，往前找 —— 不是"最后一层说了算"', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' })]),
        // 这一层有规则，但一条都匹配不上这次请求
        layer('session', [rule({ id: 's.other', effect: 'deny', capability: 'net.fetch' })]),
      ],
      tier: 'balanced',
    });
    expect(v.ruleId).toBe('u.allow');
  });
});

describe('🔴 红线不参与层序', () => {
  const allowAll = [rule({ id: 'x.allow-all', effect: 'allow', capability: '*' })];

  it('最后一层的 allow-all 翻不了红线', () => {
    for (const id of ['user', 'project', 'session'] as const) {
      const v = evaluate({
        request: req('fs.delete', '/home/ming'),
        layers: [layer('builtin', builtinRules(ENV)), layer(id, allowAll)],
        tier: 'yolo',
      });
      expect(v.effect, id).toBe('deny');
      expect(v.ruleId, id).toBe('red.fs-delete-home-root');
    }
  });

  it('会话授权也翻不了自改红线 —— 一个声明 fs.write 的普通工具照样被拦', () => {
    const grants: PermissionGrant[] = [
      {
        requestId: newRequestId(),
        capability: 'fs.write',
        target: '/repo/scripts/check-secrets.mjs',
        effect: 'allow',
        scope: 'always',
        ts: 0,
      },
    ];
    const v = evaluate({
      request: req('fs.write', '/repo/scripts/check-secrets.mjs'),
      layers: [layer('builtin', builtinRules(ENV)), layer('session', grantsToRules(grants))],
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toMatch(/^red\.self-modify-/);
  });
});

describe('YOLO 与分层', () => {
  it('ruleId 指向那条本来要问的规则 —— 审计里"跳过了 def.fs-write"才有用', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [layer('builtin', builtinRules(ENV))],
      tier: 'yolo',
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('def.fs-write');
  });

  it('用户自己写的 deny 在 YOLO 下依然拦得住', () => {
    const v = evaluate({
      request: req('fs.delete', '/home/ming/work/prod/db'),
      layers: [
        layer('builtin', builtinRules(ENV)),
        layer('user', [
          rule({
            id: 'u.protect-prod',
            effect: 'deny',
            capability: 'fs.delete',
            match: { target: '/home/ming/work/prod/**' },
          }),
        ]),
      ],
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('u.protect-prod');
  });
});

describe('tightenOnly：项目层只能收紧', () => {
  const rules: PolicyRuleSet = [
    rule({ id: 'p.allow', effect: 'allow' }),
    rule({ id: 'p.ask', effect: 'ask' }),
    rule({ id: 'p.deny', effect: 'deny' }),
  ];

  it('丢掉 allow，留下 ask 与 deny', () => {
    const out = tightenOnly(rules);
    expect(out.rules.map((r) => r.id)).toEqual(['p.ask', 'p.deny']);
  });

  it('🔴 丢掉的必须报出来 —— 静默失效等于"我写的规则怎么没用"', () => {
    expect(tightenOnly(rules).dropped).toEqual(['p.allow']);
  });
});

describe('grantsToRules：把用户当场的决定变成规则', () => {
  const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant => ({
    requestId: newRequestId(),
    capability: 'fs.write',
    target: '/work/a.ts',
    effect: 'allow',
    scope: 'session',
    ts: 0,
    ...over,
  });

  it('本会话允许 → 下一次同一个目标不再是 ask', () => {
    const g = grant();
    const layers = [layer('builtin', builtinRules(ENV)), layer('session', grantsToRules([g]))];
    expect(evaluate({ request: req('fs.write', '/work/a.ts'), layers, tier: 'balanced' }).effect).toBe(
      'allow',
    );
    // 别的文件不受影响：授权针对的是一个具体目标，不是一类操作
    expect(evaluate({ request: req('fs.write', '/work/b.ts'), layers, tier: 'balanced' }).effect).toBe(
      'ask',
    );
  });

  it('本会话拒绝也是决定 —— 只合成 allow 会让回放出的会话偏松', () => {
    const layers = [
      layer('builtin', builtinRules(ENV)),
      layer('session', grantsToRules([grant({ effect: 'deny' })])),
    ];
    expect(evaluate({ request: req('fs.write', '/work/a.ts'), layers, tier: 'balanced' }).effect).toBe(
      'deny',
    );
  });

  it('always 也进会话层 —— 否则点完"永久允许"，紧接着还会再问一遍', () => {
    expect(grantsToRules([grant({ scope: 'always' })])).toHaveLength(1);
  });

  /**
   * 这条以前断言的是"命令类能力的授权被跳过"（ADR-0020 决策三：没有契约）。
   * ADR-0026 把契约补上之后，它反过来了——而且必须反过来：不给这个选项的话，
   * 用户唯一能点的是"允许 `shell.exec` 这个能力"，一次授权放开的是**所有**命令。
   */
  it('🔴 命令类能力的授权合成得出来，且只匹配那一条命令', () => {
    const [rule] = grantsToRules([grant({ capability: 'shell.exec', target: '/bin/ls  -l' })]);
    expect(rule?.match?.target).toBe('ls -l');
  });

  it('🔴 判不了的命令授权仍然被丢弃 —— 失败关闭', () => {
    expect(
      grantsToRules([grant({ capability: 'shell.exec', target: 'rm -rf $(cat x)' })]),
    ).toHaveLength(0);
  });

  it('🔴 合成出来的规则过得了构造期闸门', () => {
    expect(() =>
      composeRules({ env: ENV, session: grantsToRules([grant(), grant({ effect: 'deny' })]) }),
    ).not.toThrow();
  });
});

describe('🔴 escapeGlobPattern：授权的 target 是字面量，不是模式', () => {
  it('文件名里的 * 不再放大匹配范围', () => {
    const pattern = escapeGlobPattern('/work/a*b');
    expect(globMatch(pattern, '/work/a*b')).toBe(true);
    expect(globMatch(pattern, '/work/aXb')).toBe(false);
    expect(globMatch(pattern, '/work/anything-b')).toBe(false);
  });

  it('? 与反斜杠同理', () => {
    expect(globMatch(escapeGlobPattern('/work/log?.txt'), '/work/logA.txt')).toBe(false);
    expect(globMatch(escapeGlobPattern('/work/log?.txt'), '/work/log?.txt')).toBe(true);
    expect(globMatch(escapeGlobPattern('/work/a\\b'), '/work/a\\b')).toBe(true);
  });

  it('一次针对单个文件的授权，只放行那一个文件', () => {
    const g: PermissionGrant = {
      requestId: newRequestId(),
      capability: 'fs.write',
      target: '/work/a*b',
      effect: 'allow',
      scope: 'always',
      ts: 0,
    };
    const layers = [layer('builtin', builtinRules(ENV)), layer('session', grantsToRules([g]))];
    expect(evaluate({ request: req('fs.write', '/work/a*b'), layers, tier: 'balanced' }).effect).toBe(
      'allow',
    );
    expect(evaluate({ request: req('fs.write', '/work/aXb'), layers, tier: 'balanced' }).effect).toBe(
      'ask',
    );
  });
});

describe('composeRules：层的拼装', () => {
  it('空层不进结果 —— 层数与"有没有配置过"一一对应', () => {
    expect(composeRules({ env: ENV }).map((l) => l.id)).toEqual(['builtin']);
    expect(
      composeRules({ env: ENV, user: [rule({ id: 'u', effect: 'ask' })], project: [] }).map(
        (l) => l.id,
      ),
    ).toEqual(['builtin', 'user']);
  });

  it('层序固定：builtin → user → project → session', () => {
    const ids = composeRules({
      env: ENV,
      user: [rule({ id: 'u', effect: 'ask' })],
      project: [rule({ id: 'p', effect: 'ask' })],
      session: [rule({ id: 's', effect: 'ask' })],
    }).map((l) => l.id);
    expect(ids).toEqual(['builtin', 'user', 'project', 'session']);
  });

  it('🔴 每一层都过构造期闸门 —— 用户写的规则才是最可能"看起来在防"的那批', () => {
    // 命令类 target 上的**红线**仍然禁止：`rm -fr /` 与 `rm -rf /` 归一后还是两个串，
    // 而红线不可覆盖、用户没有兜底手段（ADR-0026 决策四保留了 ADR-0020 的这一半）
    const bad = rule({
      id: 'u.bad',
      effect: 'deny',
      capability: 'shell.exec',
      immutable: true,
      match: { target: 'rm -rf /*' },
    });
    expect(() => composeRules({ env: ENV, user: [bad] })).toThrow(/命令类能力/);
    expect(() => composeRules({ env: ENV, project: [bad] })).toThrow(/命令类能力/);
    expect(() => composeRules({ env: ENV, session: [bad] })).toThrow(/命令类能力/);
  });
});
