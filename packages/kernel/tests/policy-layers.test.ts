import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv, RuleLayer } from '@xm/kernel';
import {
  FALLBACK_ALLOW_RULE_ID,
  builtinRules,
  composeRules,
  evaluate,
  tightenOnly,
} from '@xm/kernel';

/**
 * ── 层间语义（ADR-0023）──
 *
 * 层内语义（deny 胜 allow、后定义者胜）在 `policy-engine.test.ts` 里考，
 * 这里考的是**层与层之间**：后一层压过前一层，而红线不参与层序。
 *
 * 这套语义的由来是一个具体的失效：上一版把所有规则拍平，优先级与定义顺序无关，
 * 于是任何 allow 都压不过内置的收紧规则，`Config.permission.rules` 里的 allow 条目
 * 对所有值得授权的能力一条都不生效——用户只能收紧不能放松，而这件事没有任何地方写着。
 *
 * ADR-0039 之后这条语义比原来更吃重：**用户手写的规则是唯一的权限入口**
 * （`tier` 三档已删、事中授权已删），能不能压过内置默认直接决定用户有没有话可说。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

const req = (
  capability: Capability,
  target: string,
  trustLevel: PermissionRequest['trustLevel'] = 'model',
): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
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

const layer = (id: RuleLayer['id'], rules: PolicyRuleSet): RuleLayer => ({ id, rules });

describe('层序：后一层胜', () => {
  it('🔴 后一层的 allow 压过前一层的 deny —— 用户能放松内置默认，全靠这一条', () => {
    const v = evaluate({
      request: req('git.push', 'origin', 'untrusted'),
      layers: [
        layer('builtin', builtinRules(ENV)), // untrusted.git-push 是 deny
        layer('user', [rule({ id: 'user.push-ok', effect: 'allow', capability: 'git.push' })]),
      ],
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('user.push-ok');
  });

  it('同一层内 deny 仍然压过 allow —— 层内语义一个字没变', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [
          rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' }),
          rule({ id: 'u.deny', effect: 'deny', capability: 'fs.write' }),
        ]),
      ],
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('u.deny');
  });

  it('后一层的 deny 压过前一层的 allow', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' })]),
        layer('project', [rule({ id: 'p.deny', effect: 'deny', capability: 'fs.write' })]),
      ],
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
    });
    expect(v.effect).toBe('allow');
  });

  it('没有匹配的层被跳过，往前找 —— 不是"最后一层说了算"', () => {
    const v = evaluate({
      request: req('fs.write', '/work/a.ts'),
      layers: [
        layer('user', [rule({ id: 'u.allow', effect: 'allow', capability: 'fs.write' })]),
        // 这一层有规则，但一条都匹配不上这次请求
        layer('project', [rule({ id: 'p.other', effect: 'deny', capability: 'net.fetch' })]),
      ],
    });
    expect(v.ruleId).toBe('u.allow');
  });

  it('一条规则都没匹配上 → 兜底放行（ADR-0039）', () => {
    const v = evaluate({
      request: req('gui.capture', 'screen'),
      layers: [layer('builtin', builtinRules(ENV))],
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
  });
});

describe('🔴 红线不参与层序', () => {
  const allowAll = [rule({ id: 'x.allow-all', effect: 'allow', capability: '*' })];

  it('最后一层的 allow-all 翻不了红线', () => {
    for (const id of ['user', 'project'] as const) {
      const v = evaluate({
        request: req('fs.delete', '/home/ming'),
        layers: [layer('builtin', builtinRules(ENV)), layer(id, allowAll)],
      });
      expect(v.effect, id).toBe('deny');
      expect(v.ruleId, id).toBe('red.fs-delete-home-root');
    }
  });

  it('🔴 allow-all 也翻不了自改红线 —— 一个声明 fs.write 的普通工具照样被拦', () => {
    const v = evaluate({
      request: req('fs.write', '/repo/scripts/check-secrets.mjs'),
      layers: [layer('builtin', builtinRules(ENV)), layer('user', allowAll)],
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toMatch(/^red\.self-modify-/);
  });

  it('🔴 小明改不了自己的判权逻辑，哪怕用户层写了 allow-all', () => {
    for (const target of [
      '/repo/packages/kernel/src/policy/defaults.ts',
      '/repo/packages/contracts/src/permission/capability.ts',
      '/repo/.github/workflows/ci.yml',
      '/repo/scripts/check-file-size.mjs',
    ]) {
      const v = evaluate({
        request: req('self.modify', target),
        layers: [layer('builtin', builtinRules(ENV)), layer('user', allowAll)],
      });
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toMatch(/^red\.self-modify-/);
    }
  });

  it('但自身的**业务**代码可以随便改 —— 这正是"最终能改进自己"要的（ADR-0039）', () => {
    const v = evaluate({
      request: req('self.modify', '/repo/apps/desktop/src/renderer/App.tsx'),
      layers: [layer('builtin', builtinRules(ENV))],
    });
    expect(v.effect).toBe('allow');
  });
});

describe('tightenOnly：项目层只能收紧', () => {
  const rules: PolicyRuleSet = [
    rule({ id: 'p.allow', effect: 'allow' }),
    rule({ id: 'p.deny', effect: 'deny' }),
  ];

  it('丢掉 allow，留下 deny', () => {
    const out = tightenOnly(rules);
    expect(out.rules.map((r) => r.id)).toEqual(['p.deny']);
  });

  it('🔴 丢掉的必须报出来 —— 静默失效等于"我写的规则怎么没用"', () => {
    expect(tightenOnly(rules).dropped).toEqual(['p.allow']);
  });

  /**
   * ADR-0039 之后这条闸门直接关系到一条攻击路径：污染上下文下那三条 deny
   * （`untrusted.*`）刻意不是 immutable，为的是让**人**能在用户级配置里覆盖它们。
   * 项目级配置躺在别人的仓库里，若它也能放松，就等于"仓库里的一个文件可以放开
   * 自己被 push 的限制"。
   */
  it('🔴 项目层放不开污染上下文的 deny，用户层可以', () => {
    const allowPush = [rule({ id: 'x.push', effect: 'allow', capability: 'git.push' as const })];
    const request = () => req('git.push', 'origin', 'untrusted');

    const viaProject = evaluate({
      request: request(),
      layers: composeRules({ env: ENV, project: tightenOnly(allowPush).rules }),
    });
    expect(viaProject.effect).toBe('deny');
    expect(viaProject.ruleId).toBe('untrusted.git-push');

    const viaUser = evaluate({
      request: request(),
      layers: composeRules({ env: ENV, user: allowPush }),
    });
    expect(viaUser.effect).toBe('allow');
  });
});

describe('composeRules：层的拼装', () => {
  it('空层不进结果 —— 层数与"有没有配置过"一一对应', () => {
    expect(composeRules({ env: ENV }).map((l) => l.id)).toEqual(['builtin']);
    expect(
      composeRules({ env: ENV, user: [rule({ id: 'u', effect: 'deny' })], project: [] }).map(
        (l) => l.id,
      ),
    ).toEqual(['builtin', 'user']);
  });

  it('层序固定：builtin → user → project', () => {
    const ids = composeRules({
      env: ENV,
      user: [rule({ id: 'u', effect: 'deny' })],
      project: [rule({ id: 'p', effect: 'deny' })],
    }).map((l) => l.id);
    expect(ids).toEqual(['builtin', 'user', 'project']);
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
  });
});
