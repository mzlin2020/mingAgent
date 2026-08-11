import { describe, expect, it } from 'vitest';
import type { PermissionRequest, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import { evaluate, normalizePathPattern } from '@xm/kernel';

/**
 * ── 规则模式与请求 target 必须在**同一个坐标系**里（M1-c 补记）──
 *
 * 这一组用例的由来是三平台 CI 的第一次真跑：Linux / macOS 全绿，Windows 十条红。
 * 十条红指向同一件事——
 *
 *   请求的 target 被 `normalizePathTarget` 归一成 `C:/Users/...`（正斜杠、盘符大写），
 *   而规则里的 `match.target` 是**原样**的字符串。Windows 上用户写 `C:\Users\me\**`、
 *   授权存 `C:\work\a.md`，两边一个字符都对不上：
 *
 *     · 用户写在 config.json 里的 deny 规则 → **静默失效**
 *     · 「本会话都允许」「永久允许」 → 点了等于没点，下次照样弹框
 *
 * 而这两件事在 POSIX 上都是对的，因为那里归一是恒等变换。
 *
 * ⚠️ **内核是平台无关的，所以这组用例在任何平台上都跑。** 这正是它的价值所在：
 * 上面那个洞本来完全可以在 Linux 上被照出来，只要有人拿 Windows 形状的字符串喂过它一次。
 * 没有人喂过——于是它一路穿过 549 条用例、13 项反向演练、两份 ADR，
 * 直到推上去被 windows-latest 抓住。**"我们有三平台 CI" 不是"我们测过 Windows 语义"。**
 */

const ask = (target: string, capability: 'fs.read' | 'fs.write' = 'fs.write'): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'medium',
  reason: '测试',
  trustLevel: 'model',
});

const judge = (rules: PolicyRuleSet, request: PermissionRequest): string =>
  evaluate({ request, layers: [{ id: 'user', rules }] }).effect;

const denyRule = (target: string): PolicyRuleSet => [
  {
    id: 'user.deny',
    effect: 'deny',
    capability: 'fs.write',
    match: { target },
    reason: '不许写',
    immutable: false,
  },
];

describe('🔴 规则模式的坐标系归一', () => {
  it('🔴 用户按 Windows 写法写的 deny，真的拦得住', () => {
    expect(judge(denyRule('C:\\Users\\me\\secrets\\**'), ask('C:\\Users\\me\\secrets\\x'))).toBe(
      'deny',
    );
  });

  it('🔴 目录自身也算命中 —— 与 POSIX 的 `/**` 是同一条语义', () => {
    expect(judge(denyRule('C:\\Users\\me\\secrets\\**'), ask('C:/Users/me/secrets'))).toBe('deny');
  });

  it('模式与请求各写各的分隔符，照样是同一个位置', () => {
    expect(judge(denyRule('C:\\work\\**'), ask('C:/work/a.md'))).toBe('deny');
    expect(judge(denyRule('C:/work/**'), ask('C:\\work\\a.md'))).toBe('deny');
  });

  it('JSON 里双写的反斜杠（`C:\\\\Users`）同样折叠成分隔符', () => {
    expect(judge(denyRule('C:\\\\Users\\\\me\\\\**'), ask('C:/Users/me/x'))).toBe('deny');
  });

  it('盘符大小写不影响命中 —— 请求侧早就统一成大写了', () => {
    expect(judge(denyRule('c:\\work\\**'), ask('C:/work/a.md'))).toBe('deny');
  });

  /**
   * 反向：POSIX 上反斜杠**仍然是转义符**，一个字节都不能动。
   * 用户要放开一个名字里带 `*` 的真实文件时，靠的就是这个转义
   * （`/work/a\*b` 只匹配 `/work/a*b`，不匹配 `/work/aXb`）。
   */
  it('POSIX 模式里的反斜杠仍然是转义，不是分隔符', () => {
    expect(judge(denyRule('/work/a\\*b'), ask('/work/a*b'))).toBe('deny');
    expect(judge(denyRule('/work/a\\*b'), ask('/work/aXb'))).not.toBe('deny');
  });

  it('normalizePathPattern 只碰盘符绝对路径', () => {
    expect(normalizePathPattern('/work/a\\*b')).toBe('/work/a\\*b');
    expect(normalizePathPattern('**/.env*')).toBe('**/.env*');
    expect(normalizePathPattern('c:\\a\\b')).toBe('C:/a/b');
  });
});

/**
 * ── 用户手写的 allow 规则同样要在这个坐标系里命中（ADR-0039 之后尤其重要）──
 *
 * 这一组的前身考的是 `grantsToRules()`：把用户在审批卡片上点的"本会话都允许"
 * 合成成规则，而合成时忘了归一，Windows 上点了等于没点。审批删掉之后合成器没了，
 * 但**同一个坐标系问题原地留着**——用户唯一的放开手段变成了手写 config.json，
 * 而他在 Windows 上手写的一定是 `C:\work\a.md` 这种形状。
 */
describe('🔴 用户手写的 allow 规则：Windows 写法必须命中', () => {
  const allowRule = (pattern: string): PolicyRuleSet => [
    {
      id: 'u.allow',
      effect: 'allow',
      capability: 'fs.write',
      match: { target: pattern },
      reason: '用户自己写的',
      immutable: false,
    },
  ];
  const denyAll: PolicyRuleSet = [
    {
      id: 'b.deny',
      effect: 'deny',
      capability: 'fs.write',
      reason: '内置：默认不许写',
      immutable: false,
    },
  ];

  /** 内置层一律 deny，用户层写 allow —— 命中了才会是 allow，没命中就还是 deny */
  const judgeLayered = (userRules: PolicyRuleSet, request: PermissionRequest) =>
    evaluate({
      request,
      layers: [
        { id: 'builtin', rules: denyAll },
        { id: 'user', rules: userRules },
      ],
      pathCaseInsensitive: true,
    }).effect;

  it('🔴 反斜杠写法的 allow 命中正斜杠的请求', () => {
    expect(judgeLayered(allowRule('C:\\work\\a.md'), ask('C:/work/a.md'))).toBe('allow');
  });

  it('盘符小写写法也命中', () => {
    expect(judgeLayered(allowRule('c:\\work\\**'), ask('C:/work/sub/a.md'))).toBe('allow');
  });

  it('只放开它指名的那一个 —— 放松不该顺手扩大范围', () => {
    expect(judgeLayered(allowRule('C:\\work\\a.md'), ask('C:/work/b.md'))).toBe('deny');
  });
});
