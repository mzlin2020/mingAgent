import { describe, expect, it } from 'vitest';
import type {
  Capability,
  PermissionRequest,
  PolicyRule,
  PolicyRuleSet,
  TargetKind,
  TrustLevel,
} from '@xm/contracts';
import { ALL_CAPABILITIES, newRequestId, newSessionId, targetKindOf } from '@xm/contracts';
import {
  FALLBACK_ALLOW_RULE_ID,
  UNTRUSTED_CONTEXT_RULES,
  builtinRules,
  composeRules,
  evaluate,
  globMatch,
  redLineRules,
} from '@xm/kernel';
import type { PolicyEnv } from '@xm/kernel';

/**
 * 单层求值的便捷包装。
 *
 * 本文件里的用例考的是**层内**语义（deny 胜 allow、后定义者胜、匹配条件、红线），
 * 那些在分层之后一个字都没变，所以把整份规则放进一层是忠实的翻译。
 * **层间**语义（后一层压过前一层、项目层只能收紧）在 `policy-layers.test.ts` 里
 * 单独考，那里必须显式写出层。
 */
type EvalInput = Parameters<typeof evaluate>[0];
const judge = (
  input: Omit<EvalInput, 'layers'> & { rules: EvalInput['layers'][number]['rules'] },
): ReturnType<typeof evaluate> => {
  const { rules, ...rest } = input;
  return evaluate({ ...rest, layers: [{ id: 'builtin', rules }] });
};

/**
 * 红线依赖三个环境事实（家目录、安装目录、数据目录），所以测试也必须给出它们。
 * 这正是把 PolicyEnv 做成必填参数的用意：忘了传，编译就不过——
 * `dataDir` 加进来的那一次，三处调用点当场全红，这就是想要的效果。
 */
const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};
const BUILTIN_RULES = builtinRules(ENV);
const RED_LINE_RULES = redLineRules(ENV);

/**
 * 默认 target **随能力的 target 语义而变**（ADR-0020）。
 *
 * 以前这里对所有能力都写死 `'/work/a.ts'`，包括 `net.fetch` 与 `shell.exec`——
 * 一个路径当网络目的地、当命令行用，判定照样跑得通，因为那时根本没有规范化契约。
 * 契约落地后这批 fixture 当场全红，而这正是它该有的效果：
 * **测试里能拿路径冒充 URL，说明生产里也能。**
 */
const DEFAULT_TARGETS: Readonly<Record<TargetKind, string>> = {
  path: '/work/a.ts',
  host: 'https://example.com/x',
  // 命令行契约未落地，带 target 一律判不了；空 target 表示"这次请求没有 target"
  command: '',
  opaque: 'whatever',
};

const req = (
  capability: Capability,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target: DEFAULT_TARGETS[targetKindOf(capability)],
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
    expect: 'allow' | 'deny';
    ruleId?: string;
  }[] = [
    {
      name: '无规则 → 放行（第 3 步兜底，ADR-0039）',
      rules: [],
      expect: 'allow',
      ruleId: FALLBACK_ALLOW_RULE_ID,
    },
    {
      name: 'allow 单独存在 → allow',
      rules: [rule({ id: 'a', effect: 'allow' })],
      expect: 'allow',
      ruleId: 'a',
    },
    {
      name: 'deny 压过 allow（无论定义顺序）',
      rules: [rule({ id: 'a', effect: 'allow' }), rule({ id: 'd', effect: 'deny' })],
      expect: 'deny',
      ruleId: 'd',
    },
    {
      name: 'deny 压过 allow（反过来写也一样）',
      rules: [rule({ id: 'd', effect: 'deny' }), rule({ id: 'a', effect: 'allow' })],
      expect: 'deny',
      ruleId: 'd',
    },
    {
      name: '同优先级内后定义者胜',
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
      const verdict = judge({ request: req('fs.write'), rules: row.rules });
      expect(verdict.effect).toBe(row.expect);
      if (row.ruleId !== undefined) expect(verdict.ruleId).toBe(row.ruleId);
    });
  }

  it('每个 Verdict 都带 ruleId 与 reason —— 用户问"为什么拦我"必须答得出', () => {
    for (const capability of ALL_CAPABILITIES) {
      for (const trustLevel of ['model', 'untrusted'] satisfies TrustLevel[]) {
        const v = judge({ request: req(capability, { trustLevel }), rules: BUILTIN_RULES });
        expect(v.ruleId, `${capability}/${trustLevel}`).toBeTruthy();
        expect(v.reason, `${capability}/${trustLevel}`).toBeTruthy();
      }
    }
  });
});

/**
 * ── 判定只有两个答案（ADR-0039）──
 *
 * 这不只是一条断言，它是这次改动的**闭集证明**：把整个能力词表 × 两种信任级别
 * × 三种规则形状全跑一遍，结果必须落在 `{allow, deny}` 里。
 *
 * `ask` 已经从 `PolicyVerdict` 的联合里删掉，所以真正会在这里红的不是"多了一个值"，
 * 而是**将来有人把它加回来**——那时这条用例连同它下面那句 `satisfies` 会一起炸。
 * 编译期护栏 + 运行期穷举，两道都要，因为本项目栽过八次"规则存在但从未生效"。
 */
describe('判定结果的闭集：只有 allow 与 deny', () => {
  it('穷举 能力 × 信任级别 × 规则形状，结果只能是 allow 或 deny', () => {
    const shapes: readonly { name: string; rules: PolicyRuleSet }[] = [
      { name: '无用户规则', rules: BUILTIN_RULES },
      { name: '用户全放开', rules: [...BUILTIN_RULES, rule({ id: 'u.allow', effect: 'allow' })] },
      { name: '用户全拒绝', rules: [...BUILTIN_RULES, rule({ id: 'u.deny', effect: 'deny' })] },
    ];
    for (const capability of ALL_CAPABILITIES) {
      for (const trustLevel of ['user', 'model', 'untrusted'] satisfies TrustLevel[]) {
        for (const shape of shapes) {
          const v = judge({ request: req(capability, { trustLevel }), rules: shape.rules });
          expect(['allow', 'deny'], `${capability}/${trustLevel}/${shape.name}`).toContain(
            v.effect,
          );
        }
      }
    }
  });

  it('没有任何规则匹配时兜底放行，且 ruleId 说的就是这件事', () => {
    const v = judge({ request: req('shell.exec'), rules: [] });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
    // 不假装是某条规则放行的——审计里这两件事必须能分开
    expect(v.reason).toContain('没有任何规则匹配');
  });

  it('🔴 兜底放行拦不住红线', () => {
    const v = judge({ request: req('fs.delete', { target: '/' }), rules: BUILTIN_RULES });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.fs-delete-filesystem-root');
  });

  it('🔴 用户规则覆盖不了红线', () => {
    const userAllowsEverything: PolicyRuleSet = [
      rule({ id: 'user.allow-all', effect: 'allow', capability: '*' }),
    ];
    // 这一条必须走真正的分层：用户层排在内置层之后，正是"后面的层胜"最该被质疑的地方
    const v = evaluate({
      request: req('gui.input', { trustLevel: 'untrusted' }),
      layers: composeRules({ env: ENV, user: userAllowsEverything }),
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.gui-input-untrusted');
  });
});

/**
 * ── 不可信上下文：三条 deny 取代了整套注入降级（ADR-0039，取代 ADR-0035）──
 *
 * 判据仍是 ADR-0035 论证过的那一条：**后果留不留在本会话之外**。
 * 变的只是表达方式——从"判完之后再降一档"变成"就写成规则"。
 */
describe('PolicyEngine：不可信上下文的拒绝规则', () => {
  const CRITICAL = ['git.push', 'package.install', 'system.settings'] as const;

  it('污染后，三类"后果留在会话之外"的操作被拒绝', () => {
    for (const capability of CRITICAL) {
      const v = judge({
        request: req(capability, { trustLevel: 'untrusted' }),
        rules: BUILTIN_RULES,
      });
      expect(v.effect, capability).toBe('deny');
      expect(v.ruleId, capability).toBe(`untrusted.${capability.replace('.', '-')}`);
    }
  });

  it('干净上下文下这三条不生效 —— 它们只针对不可信上下文', () => {
    for (const capability of CRITICAL) {
      const v = judge({ request: req(capability, { trustLevel: 'model' }), rules: BUILTIN_RULES });
      expect(v.effect, capability).toBe('allow');
    }
  });

  it('日常操作不受影响 —— 否决"污染后什么都不许干"那个版本的理由就在这里', () => {
    for (const capability of ['net.fetch', 'fs.delete', 'fs.write', 'shell.exec'] as const) {
      const v = judge({
        request: req(capability, { trustLevel: 'untrusted' }),
        rules: BUILTIN_RULES,
      });
      expect(v.effect, capability).toBe('allow');
    }
  });

  it('人手写的 allow 能盖住这三条 —— 这是新模型里"知情授权"的表达方式', () => {
    const userAllow: PolicyRuleSet = [
      rule({ id: 'user.push-ok', effect: 'allow', capability: 'git.push' }),
    ];
    const v = evaluate({
      request: req('git.push', { trustLevel: 'untrusted' }),
      layers: composeRules({ env: ENV, user: userAllow }),
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('user.push-ok');
  });

  it('🔴 但它们盖不住红线 —— 同样是"污染后不许干"，红线那三条一步都不让', () => {
    const userAllow: PolicyRuleSet = [rule({ id: 'user.all', effect: 'allow', capability: '*' })];
    for (const capability of ['secrets.read', 'gui.input', 'plugin.install'] as const) {
      const v = evaluate({
        request: req(capability, { trustLevel: 'untrusted' }),
        layers: composeRules({ env: ENV, user: userAllow }),
      });
      expect(v.effect, capability).toBe('deny');
      expect(v.ruleId, capability).toMatch(/^red\./);
    }
  });

  it('三条污染规则刻意都不是 immutable —— 人要有覆盖它们的余地', () => {
    for (const r of UNTRUSTED_CONTEXT_RULES) {
      expect(r.immutable, r.id).toBe(false);
      expect(r.effect, r.id).toBe('deny');
      expect(r.match?.trustLevel, r.id).toEqual(['untrusted']);
    }
  });

  it('污染规则与红线不重叠 —— 同一条规则不许表达两处（ADR-0035 的原话）', () => {
    const redCapabilities = new Set(RED_LINE_RULES.map((r) => r.capability));
    for (const r of UNTRUSTED_CONTEXT_RULES) {
      expect(redCapabilities.has(r.capability), r.id).toBe(false);
    }
  });
});

describe('PolicyEngine：匹配条件', () => {
  it('capability 精确匹配，`*` 匹配全部', () => {
    const rules = [rule({ id: 'only-read', effect: 'allow', capability: 'fs.read' })];
    expect(judge({ request: req('fs.read'), rules }).ruleId).toBe('only-read');
    expect(judge({ request: req('fs.write'), rules }).ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
  });

  it('target glob 匹配', () => {
    const rules = [
      rule({ id: 'src-only', effect: 'allow', capability: 'fs.write', match: { target: '/work/src/**' } }),
    ];
    expect(
      judge({ request: req('fs.write', { target: '/work/src/a/b.ts' }), rules }).ruleId,
    ).toBe('src-only');
    expect(judge({ request: req('fs.write', { target: '/work/other.ts' }), rules }).ruleId).toBe(
      FALLBACK_ALLOW_RULE_ID,
    );
  });

  it('executor 匹配，默认按 local 判定', () => {
    const rules = [
      rule({ id: 'container-only', effect: 'allow', match: { executor: 'container' } }),
    ];
    expect(judge({ request: req('shell.exec'), rules }).ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
    expect(judge({ request: req('shell.exec'), rules, executor: 'container' }).ruleId).toBe(
      'container-only',
    );
  });

  it('trustLevel 匹配', () => {
    const rules = [rule({ id: 'trusted-only', effect: 'allow', match: { trustLevel: ['user'] } })];
    expect(judge({ request: req('fs.write', { trustLevel: 'user' }), rules }).ruleId).toBe(
      'trusted-only',
    );
    expect(judge({ request: req('fs.write', { trustLevel: 'model' }), rules }).ruleId).toBe(
      FALLBACK_ALLOW_RULE_ID,
    );
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

  it('不可撤销能力之外的红线数量保持克制 —— 红线一多，用户就会去找绕过的办法', () => {
    /*
     * 自改红线是一组文件路径，逐条列出反而清晰，不计入这个上限。
     *
     * ⚠️ 按 **rule id 前缀**分组，不能按 `capability !== 'self.modify'` 分组。
     * 那个写法把"能力"当成了"是不是自改红线"的代理，而自改保护现在同时挂在
     * `self.modify` / `fs.write` / `fs.delete` 三个能力上——正因为只挂 `self.modify`
     * 时，一个声明 `fs.write` 的普通写文件工具就能整体绕过它。
     * 代理一旦不成立，这条测试就会在一次**正确**的加固上报红。
     */
    const nonSelfModify = RED_LINE_RULES.filter((r) => !r.id.startsWith('red.self-modify-'));
    // M1.5 新增数据/配置两类根目录 × read/write/delete，共六条不可覆盖边界。
    expect(nonSelfModify.length).toBeLessThanOrEqual(14);
  });

  it('包含"不许改权限模块自身"这条', () => {
    const v = judge({
      request: req('self.modify', { target: '/repo/packages/kernel/src/policy/defaults.ts' }),
      rules: BUILTIN_RULES,
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toMatch(/^red\.self-modify-/);
  });
});

/**
 * ── 用户自己写的 deny 是不可协商的（docs/09 C5 的遗产）──
 *
 * 这组用例的来历值得留着：曾经 YOLO 档的判定排在普通 deny 之前，于是"这一小时别烦我"
 * 顺带注销了用户自己写下的 deny 规则。实测 `deny fs.delete ~/work/prod/**`：
 * balanced 档 DENY、yolo 档 ALLOW，而且恰好在用户放手让它长跑时失效。
 *
 * ADR-0039 删掉了档位，那条具体的失效路径不存在了；但它保护的东西——
 * **用户写下的 deny 谁都翻不了**——现在由第 2 步的"层内 deny 胜 allow"承担，
 * 所以这组断言原样保留，只是不再有 tier 参数可传。
 */
describe('用户自己写的 deny', () => {
  const USER_DENY = {
    id: 'user.protect-prod',
    effect: 'deny' as const,
    capability: 'fs.delete' as const,
    match: { target: '/home/ming/work/prod/**' },
    reason: '用户自己写的：这个目录不许动',
    immutable: false,
  };
  const RULES = [...BUILTIN_RULES, USER_DENY];

  const ask = (capability: Capability, target: string) =>
    judge({
      request: {
        requestId: newRequestId(),
        sessionId: newSessionId(),
        capability,
        target,
        risk: 'high',
        reason: '测试',
        trustLevel: 'model',
      },
      rules: RULES,
    });

  it('拦得住它指名的目标', () => {
    const v = ask('fs.delete', '/home/ming/work/prod/db');
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('user.protect-prod');
  });

  it('红线同样拦得住', () => {
    expect(ask('fs.delete', '/home/ming').effect).toBe('deny');
    expect(ask('fs.write', '/repo/scripts/check-secrets.mjs').effect).toBe('deny');
  });

  it('它没管到的目标照常放行 —— 拒绝清单是清单，不是全局开关', () => {
    const v = ask('fs.delete', '/home/ming/work/scratch/tmp');
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe(FALLBACK_ALLOW_RULE_ID);
  });
});

/**
 * `shell.session`（ADR-0031）打开会话时判一次权，之后 write/resize/close 完全不再判
 * （声明空能力集）。ADR-0039 之前那一次判权是一个 ask——"同意一次就等于对这个会话
 * 生命周期内的一切输入放弃逐条判断"，那个 ask 是唯一的知情点。
 *
 * 现在它按 deny 清单判：没撞上就直接开。**结构性代价没有变化，但唯一的缓解手段
 * （打开时问一次）消失了** —— 这条记在 ADR-0039 的遗留里，不在本轮解决。
 */
describe('shell.session 的判权（ADR-0031）', () => {
  it('打开会话默认放行 —— 没有规则拦它', () => {
    const v = judge({ request: req('shell.session'), rules: BUILTIN_RULES });
    expect(v.effect).toBe('allow');
  });

  it('用户自己写的 deny 依然拦得住 open —— 这是现在唯一还能拦住 PTY 的东西', () => {
    const userDeny: PolicyRuleSet = [
      rule({
        id: 'user.no-terminal-in-prod',
        effect: 'deny',
        capability: 'shell.session',
        match: { target: '/repo/prod/**' },
      }),
    ];
    const v = judge({
      request: req('shell.session', { target: '/repo/prod/app' }),
      rules: [...BUILTIN_RULES, ...userDeny],
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('user.no-terminal-in-prod');
  });
});
