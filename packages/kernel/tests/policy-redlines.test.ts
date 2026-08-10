import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import { builtinRules, evaluate, globMatch, normalizePathTarget } from '@xm/kernel';
import type { PolicyEnv } from '@xm/kernel';

/**
 * 单层求值的便捷包装。
 *
 * 本文件里的用例考的是**层内**语义（deny > ask > allow、后定义者胜、匹配条件、红线），
 * 那些在分层之后一个字都没变，所以把整份规则放进一层是忠实的翻译。
 * **层间**语义（后一层压过前一层、项目层只能收紧、会话授权）在
 * `policy-layers.test.ts` 里单独考，那里必须显式写出层。
 */
type EvalInput = Parameters<typeof evaluate>[0];
const judge = (
  input: Omit<EvalInput, 'layers'> & { rules: EvalInput['layers'][number]['rules'] },
): ReturnType<typeof evaluate> => {
  const { rules, ...rest } = input;
  return evaluate({ ...rest, layers: [{ id: 'builtin', rules }] });
};

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
  judge({
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

  /*
   * Windows 没有单一的 `/`——盘符根目录才是它的等价物，而 `normalizePathTarget`
   * 从不把两者归成同一个串。这条红线在 M1-d 之前从来没有被真实触发过：
   * 第一个能产出 fs.delete 到盘符根的真实调用点是 shell.exec（ADR-0026）的
   * `rm -rf /`——网关按会话 cwd 把 POSIX 写法的 `/` 解析到当前盘符根，
   * 而当时只有 `red.fs-delete-filesystem-root` 一条，坐标系对不上，
   * windows-latest 的 CI 矩阵第一次真实喂给它时当场照出（ADR-0026）。
   */
  it('🔴 Windows 盘符根目录同样命中，且是另一条红线（POSIX 的 "/" 救不了它）', () => {
    for (const target of ['C:/', 'D:/', 'Z:/']) {
      const v = verdict('fs.delete', target);
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId, target).toBe('red.fs-delete-drive-root');
    }
  });

  it('盘符根目录的红线不会误伤更深的路径', () => {
    const v = verdict('fs.delete', 'C:/work/build');
    expect(v.ruleId).not.toBe('red.fs-delete-drive-root');
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
    const v = judge({
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
    const v = judge({
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
  /*
   * ADR-0035 把这一段收窄到**严重项**：后果留在本会话之外的那几件事仍然硬 deny，
   * 其余停在一个指名污染源的高警示 ask。理由是硬 deny 之下用户想继续只能去
   * 「解除标记」，那把整轮防线一起放倒——比他实际想做的决定大得多，
   * 而防线越是只剩"全开或全关"，用户就越会选全关。
   */
  it('🔴 untrusted + 严重项 + 本来 ask → deny', () => {
    for (const [capability, target] of [
      ['git.push', '/repo'],
      ['package.install', 'lodash'],
      ['system.settings', 'dark-mode'],
    ] as const) {
      const v = judge({
        request: { ...req(capability, target), trustLevel: 'untrusted' },
        rules: RULES,
        tier: 'balanced',
      });
      expect(v.effect, capability).toBe('deny');
      expect(v.ruleId, capability).toBe('builtin.injection-downgrade');
    }
  });

  it('🔴 untrusted + 非严重项 + 本来 ask → 高警示 ask（仍然指向注入降级）', () => {
    for (const [capability, target] of [
      ['fs.delete', '/repo/src/a.ts'],
      ['net.fetch', 'https://example.com'],
    ] as const) {
      const v = judge({
        request: { ...req(capability, target), trustLevel: 'untrusted' },
        rules: RULES,
        tier: 'balanced',
      });
      expect(v.effect, capability).toBe('ask');
      expect(v.ruleId, capability).toBe('builtin.injection-downgrade');
    }
  });

  it('可撤销的能力不降级 —— 全局收紧会被用户整体关掉，等于防御不存在', () => {
    const v = judge({
      request: { ...req('fs.write', '/repo/src/a.ts'), trustLevel: 'untrusted' },
      rules: RULES,
      tier: 'balanced',
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe('def.fs-write');
  });

  it('可信上下文下 ask 保持 ask', () => {
    expect(judge({ request: req('git.push', '/repo'), rules: RULES, tier: 'balanced' }).effect)
      .toBe('ask');
  });
});

/**
 * ── 自改红线不能只挂在 `self.modify` 上 ──
 *
 * M0-b 复审实测出来的洞：九条自改红线全部只声明 `capability: 'self.modify'`，
 * 而能力是**工具自报的**。一个通用写文件工具报的是 `fs.write`，它根本不知道
 * 自己正在改的是权限判定逻辑——于是九条红线被最普通的一个工具整体绕过，
 * 降级成 `def.fs-write` 的一个确认框。
 *
 * 同一份 defaults.ts 里的审计库红线写对了（挂在 fs.write / fs.delete 上）。
 * 所以这不是"想不到"，是同一个教训只学了一半：
 * **红线要按"目标是什么"写，不能按"调用方自称在做什么"写。**
 */
describe('自改红线：按目标而不是按自报能力', () => {
  const PROTECTED = [
    '/repo/packages/kernel/src/policy/defaults.ts',
    '/repo/packages/contracts/src/permission/capability.ts',
    '/repo/packages/contracts/src/base/redact.ts',
    '/repo/scripts/check-secrets.mjs',
    '/repo/.dependency-cruiser.cjs',
    '/repo/eslint.config.js',
    '/repo/.githooks/pre-commit',
    '/repo/.github/workflows/ci.yml',
  ];

  it.each(PROTECTED)('%s：三种能力一律 deny，不是 ask', (path) => {
    for (const cap of ['self.modify', 'fs.write', 'fs.delete'] as const) {
      const v = verdict(cap, path);
      expect(v.effect, `${cap} → ${path}`).toBe('deny');
      expect(v.ruleId, `${cap} → ${path}`).toMatch(/^red\.self-modify-/);
    }
  });

  it('绕过手法一：换等价写法拼路径', () => {
    for (const raw of [
      '/repo/packages/kernel/src/policy/../policy/defaults.ts',
      '/repo/./scripts/check-secrets.mjs',
      '/repo//scripts//check-secrets.mjs',
    ]) {
      expect(verdict('fs.write', raw).effect, raw).toBe('deny');
    }
  });

  it('绕过手法二：Windows 上改大小写（需运行时打开 pathCaseInsensitive）', () => {
    const p = '/repo/Scripts/Check-Secrets.mjs';
    expect(verdict('fs.write', p, false).effect, '大小写敏感：本就不该命中').toBe('ask');
    expect(verdict('fs.write', p, true).effect, '大小写不敏感：必须命中').toBe('deny');
  });

  it('保护范围之外的文件不受影响 —— 红线不能宽到让人去找绕过的办法', () => {
    expect(verdict('fs.write', '/repo/packages/runtime/src/turn.ts').effect).toBe('ask');
    expect(verdict('fs.write', '/repo/README.md').effect).toBe('ask');
  });
});

/**
 * ── `~` 的两种含义，以及 Windows 8.3 短名这条绕过路径 ──
 *
 * 三平台 CI 首次实跑（2026-08-05）在 Windows 上抓到的：`os.tmpdir()` 返回
 * `C:\Users\RUNNER~1\AppData\Local\Temp\...`，而 `normalizePathTarget` 当时
 * 拒绝**一切**含 `~` 的路径，理由写的是"调用方没有展开家目录"。
 *
 * 那条规则把两件不相干的事混成了一条：
 *   · shell 的家目录展开 —— 语法上永远是**行首**的 `~`
 *   · Windows 8.3 短文件名 —— `~` 出现在**段中间**，是长名的合法别名
 *
 * 混在一起的代价是双向的：Windows 上应用直接起不来（误杀），
 * 而真正该防的别名问题从来没被单独说清过。
 */
describe('`~` 的两种含义', () => {
  it('行首的 `~` 是没展开的家目录，拒绝', () => {
    for (const raw of ['~', '~/Documents', '~/.ssh/id_rsa', '~ming/work', '~\\Documents']) {
      const r = normalizePathTarget(raw);
      expect(r.ok, raw).toBe(false);
      expect(!r.ok && r.reason, raw).toMatch(/家目录/);
    }
  });

  it('段中间的 `~` 是合法文件名，不该被误杀', () => {
    // POSIX 上 emacs / vim 的备份文件就长这样，是再普通不过的路径
    for (const raw of ['/home/u/notes.txt~', '/home/u/a~b/c', '/tmp/foo~']) {
      const r = normalizePathTarget(raw);
      expect(r.ok, raw).toBe(true);
    }
  });
});

describe('Windows 8.3 短文件名：一条真实的红线绕过路径', () => {
  it('短名段被拒绝 —— 内核解析不了别名，只能失败关闭', () => {
    for (const raw of [
      'C:/PROGRA~1/xiaoming/app.exe',
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x',
      'C:/Users/MYDOCU~1.TXT',
    ]) {
      const r = normalizePathTarget(raw);
      expect(r.ok, raw).toBe(false);
      expect(!r.ok && r.reason, raw).toMatch(/8\.3|短文件名/);
    }
  });

  it('🔴 拒绝的理由：短名与长名指向同一个文件，红线却只按长名匹配', () => {
    // 假设红线护着 C:/Program Files/xiaoming 下的自改文件。
    // 若短名被放行，它会绕过所有按长名写的规则 —— 而这正是 target 规范化存在的意义。
    const long = 'C:/Program Files/xiaoming/scripts/check-secrets.mjs';
    const short = 'C:/PROGRA~1/xiaoming/scripts/check-secrets.mjs';

    const rules = builtinRules({ ...ENV, appRoot: 'C:/Program Files/xiaoming' });
    const ask = (target: string) =>
      judge({
        request: req('fs.write', target),
        rules,
        tier: 'yolo',
        pathCaseInsensitive: true,
      });

    expect(ask(long).effect, '长名必须命中红线').toBe('deny');
    expect(ask(long).ruleId).toMatch(/^red\.self-modify-/);

    // 短名同样是 deny，但走的是"判不了"这条路 —— 关键是**它不能是 allow/ask**
    const s = ask(short);
    expect(s.effect, '短名必须失败关闭').toBe('deny');
    expect(s.ruleId).toBe('builtin.invalid-target');
  });

  it('普通 Windows 路径不受影响', () => {
    for (const raw of ['C:/Users/runneradmin/x', 'D:\\work\\repo\\src\\a.ts']) {
      expect(normalizePathTarget(raw).ok, raw).toBe(true);
    }
  });
});
