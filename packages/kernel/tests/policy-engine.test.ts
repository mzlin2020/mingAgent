import { describe, expect, it } from 'vitest';
import type {
  Capability,
  PermissionRequest,
  PolicyRule,
  PolicyRuleSet,
  TargetKind,
  TrustLevel,
} from '@xm/contracts';
import {
  ALL_CAPABILITIES,
  IRREVERSIBLE_CAPABILITIES,
  newRequestId,
  newSessionId,
  targetKindOf,
} from '@xm/contracts';
import {
  INJECTION_DOWNGRADE_RULE_ID,
  TIER_FALLBACK_RULE_ID,
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
 * 红线依赖三个环境事实（家目录、安装目录、数据目录），所以测试也必须给出它们。
 * 这正是把 PolicyEnv 做成必填参数的用意：忘了传，编译就不过——
 * `dataDir` 加进来的那一次，三处调用点当场全红，这就是想要的效果。
 */
const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
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
      const verdict = judge({
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
        const v = judge({ request: req(capability), rules: BUILTIN_RULES, tier });
        expect(v.ruleId, `${capability}/${tier}`).toBeTruthy();
        expect(v.reason, `${capability}/${tier}`).toBeTruthy();
      }
    }
  });
});

describe('PolicyEngine：档位兜底', () => {
  it('平衡档：safe 放行，其余询问', () => {
    expect(judge({ request: req('net.listen', { risk: 'safe' }), rules: [], tier: 'balanced' }).effect).toBe('allow');
    expect(judge({ request: req('net.listen', { risk: 'low' }), rules: [], tier: 'balanced' }).effect).toBe('ask');
  });

  it('严格档：一律询问，safe 也不例外', () => {
    expect(judge({ request: req('fs.read', { risk: 'safe' }), rules: [], tier: 'strict' }).effect).toBe('ask');
  });

  it('YOLO 档：默认放行', () => {
    expect(judge({ request: req('shell.exec'), rules: [], tier: 'yolo' }).effect).toBe('allow');
  });

  it('🔴 YOLO 也拦不住红线', () => {
    const v = judge({
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
    // 这一条必须走真正的分层：用户层排在内置层之后，正是"后面的层胜"最该被质疑的地方
    const v = evaluate({
      request: req('gui.input', { trustLevel: 'untrusted' }),
      layers: composeRules({ env: ENV, user: userAllowsEverything }),
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.gui-input-untrusted');
  });
});

describe('PolicyEngine：提示词注入降级', () => {
  it('untrusted + 不可撤销能力 + 本来 allow → 降级为 ask', () => {
    for (const capability of IRREVERSIBLE_CAPABILITIES) {
      const v = judge({
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
    const v = judge({
      request: req('fs.write', { trustLevel: 'untrusted' }),
      rules: [rule({ id: 'a', effect: 'allow' })],
      tier: 'balanced',
    });
    expect(v.effect).toBe('allow');
  });

  it('trustLevel=model 或 user 时不降级 —— 全局收紧会被用户整体关掉', () => {
    for (const trustLevel of ['user', 'model'] satisfies TrustLevel[]) {
      const v = judge({
        request: req('net.fetch', { trustLevel }),
        rules: [rule({ id: 'a', effect: 'allow' })],
        tier: 'balanced',
      });
      expect(v.effect, trustLevel).toBe('allow');
    }
  });

  it('降级只把 allow 变 ask，不会把 deny 变松', () => {
    const v = judge({
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
    expect(judge({ request: req('fs.read'), rules, tier: 'balanced' }).ruleId).toBe('only-read');
    expect(judge({ request: req('fs.write'), rules, tier: 'balanced' }).ruleId).toBe(
      TIER_FALLBACK_RULE_ID,
    );
  });

  it('target glob 匹配', () => {
    const rules = [
      rule({ id: 'src-only', effect: 'allow', capability: 'fs.write', match: { target: '/work/src/**' } }),
    ];
    expect(
      judge({ request: req('fs.write', { target: '/work/src/a/b.ts' }), rules, tier: 'balanced' })
        .ruleId,
    ).toBe('src-only');
    expect(
      judge({ request: req('fs.write', { target: '/work/other.ts' }), rules, tier: 'balanced' })
        .ruleId,
    ).toBe(TIER_FALLBACK_RULE_ID);
  });

  it('executor 匹配，默认按 local 判定', () => {
    const rules = [
      rule({ id: 'container-only', effect: 'allow', match: { executor: 'container' } }),
    ];
    expect(judge({ request: req('shell.exec'), rules, tier: 'balanced' }).ruleId).toBe(
      TIER_FALLBACK_RULE_ID,
    );
    expect(
      judge({ request: req('shell.exec'), rules, tier: 'balanced', executor: 'container' })
        .ruleId,
    ).toBe('container-only');
  });

  it('trustLevel 匹配', () => {
    const rules = [rule({ id: 'trusted-only', effect: 'allow', match: { trustLevel: ['user'] } })];
    expect(
      judge({ request: req('fs.write', { trustLevel: 'user' }), rules, tier: 'balanced' }).ruleId,
    ).toBe('trusted-only');
    expect(
      judge({ request: req('fs.write', { trustLevel: 'model' }), rules, tier: 'balanced' }).ruleId,
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
    expect(nonSelfModify.length).toBeLessThanOrEqual(8);
  });

  it('包含"不许改权限模块自身"这条', () => {
    const v = judge({
      request: req('self.modify', { target: '/repo/packages/kernel/src/policy/defaults.ts' }),
      rules: BUILTIN_RULES,
      tier: 'balanced',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toMatch(/^red\.self-modify-/);
  });
});

/**
 * ── YOLO 跳过 ask，不跳过 deny（docs/09 C5 定稿）──
 *
 * 复审前：YOLO 的判定排在**普通 deny 之前**，于是它连用户自己写下的 deny 规则
 * 一起忽略掉了。实测 `deny fs.delete /home/ming/work/prod/**`：
 * balanced 档 DENY，yolo 档 ALLOW。
 *
 * 那个语义站不住：YOLO 的意思是"别再问我了"，不是"忘掉我说过不许碰的地方"。
 * 前者省的是确认框，后者删掉的是用户唯一能表达"这里绝对不行"的手段——
 * 而且恰好在最危险的时候失效，因为用户开 YOLO 正是为了放手让它长时间自己跑。
 */
describe('YOLO 档的边界', () => {
  const ENV = {
    home: '/home/ming',
    appRoot: '/repo',
    dataDir: '/home/ming/.local/share/xiaoming',
  };
  const USER_DENY = {
    id: 'user.protect-prod',
    effect: 'deny' as const,
    capability: 'fs.delete' as const,
    match: { target: '/home/ming/work/prod/**' },
    reason: '用户自己写的：这个目录不许动',
    immutable: false,
  };
  const RULES = [...builtinRules(ENV), USER_DENY];

  const ask = (capability: Capability, target: string, tier: 'balanced' | 'yolo') =>
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
      tier,
    });

  it('用户自己写的 deny 在 YOLO 下依然拦得住', () => {
    const target = '/home/ming/work/prod/db';
    expect(ask('fs.delete', target, 'balanced').ruleId).toBe('user.protect-prod');
    expect(ask('fs.delete', target, 'yolo').effect).toBe('deny');
    expect(ask('fs.delete', target, 'yolo').ruleId).toBe('user.protect-prod');
  });

  it('红线在 YOLO 下依然拦得住', () => {
    expect(ask('fs.delete', '/home/ming', 'yolo').effect).toBe('deny');
    expect(ask('fs.write', '/repo/scripts/check-secrets.mjs', 'yolo').effect).toBe('deny');
  });

  it('但 ask 确实被跳过 —— 否则 YOLO 就没有存在意义了', () => {
    expect(ask('fs.delete', '/home/ming/work/scratch/tmp', 'balanced').effect).toBe('ask');
    expect(ask('fs.delete', '/home/ming/work/scratch/tmp', 'yolo').effect).toBe('allow');
  });
});

/**
 * `shell.session`（ADR-0031）只在打开会话这一刻接入这套已验证过的机制一次——
 * balanced 问一次、yolo 跳过那次问、任何 deny（内置或用户自己写的）都不受影响。
 * 会话打开之后 write/resize/close 完全不再判权，是判权设计本身的选择，不是这里
 * 要测的东西（那部分靠 tools-core 里"声明空能力集"这件事本身来保证）。
 */
describe('shell.session 的默认规则（ADR-0031）', () => {
  const RULES = builtinRules(ENV);

  it('balanced 档：打开会话要问一次', () => {
    expect(judge({ request: req('shell.session'), rules: RULES, tier: 'balanced' }).effect).toBe(
      'ask',
    );
  });

  it('yolo 档：跳过这次问', () => {
    expect(judge({ request: req('shell.session'), rules: RULES, tier: 'yolo' }).effect).toBe(
      'allow',
    );
  });

  it('用户自己写的 deny 在 yolo 档依然拦得住 open', () => {
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
      rules: [...RULES, ...userDeny],
      tier: 'yolo',
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('user.no-terminal-in-prod');
  });
});
