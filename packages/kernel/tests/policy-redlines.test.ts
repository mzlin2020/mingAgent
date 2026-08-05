import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import { builtinRules, evaluate, globMatch, normalizePathTarget } from '@xm/kernel';
import type { PolicyEnv } from '@xm/kernel';

/**
 * 红线的**真实输入**回归测试。
 *
 * 这个文件的每一条都来自 2026-08-04 的一次实测：当时红线全部"已配置"，
 * 但拿运行时真正会传的字符串去打，几乎全不命中——
 *
 *   fs.delete "/tmp/.."   → ask（红线写的是 "/"，字符串不等）
 *   fs.delete "/home/ming"→ ask（红线写的是 "~"，而 ~ 永远不会出现在真实 target 里）
 *   self.modify 相对路径   → ask（红线是绝对 glob）
 *
 * 三条红线在真实输入下形同虚设，而任何输出都显示"规则已加载"。这正是 ADR-0011 那条
 * 纪律的第三个实例：**规则存在 ≠ 规则生效**。所以下面全部按"攻击者会怎么拼这个字符串"
 * 来写，而不是按"规则里写了什么"来写。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  // 真实形态：env-paths 在 Linux 上给出的数据目录（ADR-0014）。刻意不写成 `~/.xiaoming`
  // ——运行时传进来的永远是展开后的绝对路径，拿 `~` 去测就是在测一个不存在的输入
  dataDir: '/home/ming/.local/share/xiaoming',
};
const RULES = builtinRules(ENV);

const req = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'high',
  reason: '测试',
  trustLevel: 'model',
});

const verdict = (capability: Capability, target: string, caseInsensitive = false) =>
  evaluate({
    request: req(capability, target),
    rules: RULES,
    tier: 'balanced',
    pathCaseInsensitive: caseInsensitive,
  });

describe('路径规范化', () => {
  it('等价写法归一到同一个串', () => {
    for (const raw of ['/', '//', '/.', '/tmp/..', '/home/u/../..', '/a/../']) {
      const r = normalizePathTarget(raw);
      expect(r.ok && r.value, raw).toBe('/');
    }
    const nested = normalizePathTarget('/a//b/./c/');
    expect(nested.ok && nested.value).toBe('/a/b/c');
  });

  it('Windows 路径统一成正斜杠、盘符大写', () => {
    const r = normalizePathTarget('c:\\Users\\ming\\..\\ming\\x.ts');
    expect(r.ok && r.value).toBe('C:/Users/ming/x.ts');
  });

  it('🔴 判不了的一律失败关闭，不是"尽力猜"', () => {
    for (const raw of ['', 'relative/path', './x', '~', '~/.ssh/id_rsa', '/etc/pas\0swd']) {
      expect(normalizePathTarget(raw).ok, raw).toBe(false);
    }
  });
});

describe('红线：删除根目录', () => {
  it('🔴 各种等价写法全部命中（修复前只有精确的 "/" 命中）', () => {
    for (const target of ['/', '//', '/.', '/tmp/..', '/home/u/../..']) {
      const v = verdict('fs.delete', target);
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toBe('red.fs-delete-filesystem-root');
    }
  });
});

describe('红线：删除家目录', () => {
  it('🔴 命中的是展开后的绝对路径（修复前红线写 "~"，永不命中）', () => {
    for (const target of ['/home/ming', '/home/ming/', '/home/ming/x/..']) {
      const v = verdict('fs.delete', target);
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toBe('red.fs-delete-home-root');
    }
  });

  it('删家目录里的某个文件不是红线 —— 那是日常操作', () => {
    expect(verdict('fs.delete', '/home/ming/tmp/a.log').effect).toBe('ask');
  });
});

describe('红线：自我修改', () => {
  const protectedPaths = [
    '/repo/packages/kernel/src/policy/engine.ts',
    '/repo/packages/kernel/src/policy', // 目录本身也要拦（`/**` 结尾的语义）
    '/repo/packages/contracts/src/permission/capability.ts',
    '/repo/packages/contracts/src/base/redact.ts',
    '/repo/scripts/check-secrets.mjs',
    '/repo/.dependency-cruiser.cjs',
    '/repo/eslint.config.js',
    '/repo/.github/workflows/ci.yml',
  ];

  it('🔴 护栏自身全部落在红线内', () => {
    for (const target of protectedPaths) {
      const v = verdict('self.modify', target);
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toMatch(/^red\.self-modify-/);
    }
  });

  it('普通业务代码不在红线内，只是需要确认', () => {
    expect(verdict('self.modify', '/repo/packages/kernel/src/tool/truncate.ts').effect).toBe('ask');
  });

  it('🔴 相对路径不再"绕过"，而是被判为不可判定并拒绝', () => {
    const v = verdict('self.modify', 'packages/kernel/src/policy/engine.ts');
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('builtin.invalid-target');
  });
});

describe('glob 在安全边界上的语义', () => {
  it('🔴 `/**` 结尾必须匹配目录自身', () => {
    expect(globMatch('/prod/**', '/prod')).toBe(true);
    expect(globMatch('/prod/**', '/prod/a/b')).toBe(true);
    expect(globMatch('/prod/**', '/production')).toBe(false);
  });

  it('`*` 不跨越分隔符', () => {
    expect(globMatch('/a/*', '/a/b')).toBe(true);
    expect(globMatch('/a/*', '/a/b/c')).toBe(false);
  });

  it('🔴 Windows 上大小写不敏感，否则改个大小写就绕过红线', () => {
    expect(verdict('self.modify', 'C:/REPO/scripts/x.mjs').effect).toBe('ask');

    const winEnv: PolicyEnv = {
      home: 'C:/Users/ming',
      appRoot: 'C:/repo',
      dataDir: 'C:/Users/ming/AppData/Roaming/xiaoming',
    };
    const v = evaluate({
      request: req('self.modify', 'C:/REPO/SCRIPTS/check-secrets.mjs'),
      rules: builtinRules(winEnv),
      tier: 'balanced',
      pathCaseInsensitive: true,
    });
    expect(v.effect).toBe('deny');
  });
});

describe('红线不受档位影响', () => {
  it('🔴 YOLO 也拦得住删根', () => {
    const v = evaluate({
      request: req('fs.delete', '/tmp/..'),
      rules: RULES,
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
  });
});

/**
 * 注入降级的**第二段**。
 *
 * ADR-0003 与 docs/06 §4.2 都写的是"收紧一档：allow → ask，ask → deny"，但实现只做了
 * 前半段，而且 `ask` 分支根本没经过降级函数。后果很具体：注入攻击的典型形状是
 * "读到外部内容 → 立刻做一次不可撤销的操作"，而那类操作（git push / fs.delete /
 * net.fetch）在默认规则里**本来就是 ask**——只做 allow→ask 等于在攻击路径上什么都没变，
 * 用户看到的还是那个每天都点的确认框。
 */
describe('注入降级：ask → deny', () => {
  it('🔴 untrusted + 不可撤销 + 本来 ask → deny', () => {
    for (const [capability, target] of [
      ['git.push', '/repo'],
      ['fs.delete', '/repo/src/a.ts'],
      ['net.fetch', 'https://example.com'],
    ] as const) {
      const v = evaluate({
        request: { ...req(capability, target), trustLevel: 'untrusted' },
        rules: RULES,
        tier: 'balanced',
      });
      expect(v.effect, capability).toBe('deny');
      expect(v.ruleId, capability).toBe('builtin.injection-downgrade');
    }
  });

  it('可撤销的能力不降级 —— 全局收紧会被用户整体关掉，等于防御不存在', () => {
    const v = evaluate({
      request: { ...req('fs.write', '/repo/src/a.ts'), trustLevel: 'untrusted' },
      rules: RULES,
      tier: 'balanced',
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe('def.fs-write');
  });

  it('可信上下文下 ask 保持 ask', () => {
    expect(evaluate({ request: req('git.push', '/repo'), rules: RULES, tier: 'balanced' }).effect)
      .toBe('ask');
  });
});
