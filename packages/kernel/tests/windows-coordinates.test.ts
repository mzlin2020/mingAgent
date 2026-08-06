import { describe, expect, it } from 'vitest';
import type { PermissionRequest, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PermissionGrant } from '@xm/kernel';
import { evaluate, grantsToRules, normalizePathPattern } from '@xm/kernel';

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
  evaluate({ request, layers: [{ id: 'user', rules }], tier: 'balanced' }).effect;

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
   * `escapeGlobPattern` 整个依赖这一点——它把一次针对单个文件的授权
   * escape 成只匹配它自己的模式（`/work/a\*b` 不该放行 `/work/aXb`）。
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

describe('🔴 会话授权：合成出来的规则要真的能命中', () => {
  const grant = (target: string): PermissionGrant[] => [
    {
      requestId: newRequestId(),
      capability: 'fs.write',
      target,
      effect: 'allow',
      scope: 'session',
      ts: 0,
    },
  ];

  it('🔴 Windows 写法的授权，下一次调用真的不再问', () => {
    // 授权存的是网关给的原生路径，判定比的是规范化后的路径 —— 中间必须归一
    const rules = grantsToRules(grant('C:\\work\\a.md'));
    expect(judge(rules, ask('C:/work/a.md'))).toBe('allow');
  });

  it('授权仍然只覆盖那一个文件', () => {
    const rules = grantsToRules(grant('C:\\work\\a.md'));
    expect(judge(rules, ask('C:/work/b.md'))).not.toBe('allow');
  });

  it('🔴 转义没有因为归一而失效 —— `a*b` 的授权不放行 `aXb`', () => {
    const rules = grantsToRules(grant('/work/a*b'));
    expect(judge(rules, ask('/work/a*b'))).toBe('allow');
    expect(judge(rules, ask('/work/aXb'))).not.toBe('allow');
  });

  it('🔴 规范化不了的授权直接丢掉 —— 判定时必然 deny 的东西，别合成成"已授权"', () => {
    // 相对路径：内核判不了 → 失败关闭
    expect(grantsToRules(grant('work/a.md'))).toHaveLength(0);
    // 8.3 短名：同理，它是长名的别名，按短名授权等于授权了一个匹配不上的东西
    expect(grantsToRules(grant('C:\\Users\\RUNNER~1\\a.md'))).toHaveLength(0);
  });

  it('授权的 target 与红线是同一个坐标系 —— `..` 也消解掉', () => {
    const rules = grantsToRules(grant('/work/sub/../a.md'));
    expect(judge(rules, ask('/work/a.md'))).toBe('allow');
  });
});
