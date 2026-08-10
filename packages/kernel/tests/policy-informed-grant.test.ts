import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newRequestId, newSessionId } from '@xm/contracts';
import type { PermissionGrant, PolicyEnv, RuleLayer } from '@xm/kernel';
import { INJECTION_DOWNGRADE_RULE_ID, builtinRules, evaluate, grantsToRules } from '@xm/kernel';

/**
 * ── 知情授权穿透注入降级（ADR-0034）──
 *
 * 这个文件存在的理由是一次**真实体验反馈**：用户让小明联网搜索，每一个网址都被
 * 要一次授权，即便桌面端已经开到「帮我批准」/「完全访问权限」。
 *
 * 机制是一个自我污染循环，`net.fetch` 同时在两张表里：
 *
 *   · `UNTRUSTED_CONTENT_CAPABILITIES` —— 它是污点源
 *   · `IRREVERSIBLE_CAPABILITIES`      —— 它是注入降级要打回的对象
 *
 * 于是第一次 `web.fetch` 把自己所在的会话污染掉（`taintOf` 标在 `tool.start`，粘性），
 * 此后每一次 fetch 都在 `evaluate()` 最后一步被 `downgradeIfUntrusted` 打回 ask。
 * 而那一步排在 YOLO 之后，也排在**所有层**之后——于是三件事同时失效：
 * 「帮我批准」穿不过去、用户 config 里的 allow 穿不过去、
 * **用户当场点的「本会话都允许」也穿不过去**。
 *
 * 最后一条才是真正的噪音来源：同一个域名，用户已经明确回答过一次的问题，
 * 每一次调用都要重新问一遍。`turn.ts` 自己写着"审批噪音会直接转化成
 * 「下次顺手点允许」"——这就是那句话的实例。
 *
 * 本文件考的是修法的**边界**：穿透只给「知情的、针对具体目标的、会话层的」授权，
 * 其余一律照常降级。每一条 `🔴` 都是"少了它就等于把注入防御整体关掉"的那种。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

/** 上下文被污染的时刻。授权发生在它之前还是之后，是本文件的核心变量 */
const TAINTED_AT = 1_000;

const req = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'medium',
  reason: '测试',
  trustLevel: 'untrusted',
});

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'effect'>): PolicyRule => ({
  capability: '*',
  reason: r.id,
  immutable: false,
  ...r,
});

const layer = (id: RuleLayer['id'], rules: PolicyRuleSet): RuleLayer => ({ id, rules });

const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant => ({
  requestId: newRequestId(),
  capability: 'net.fetch',
  target: 'https://example.com',
  effect: 'allow',
  scope: 'session',
  // 默认是"污染之后才做的决定"——用户是看着不可信横幅点下去的
  ts: TAINTED_AT + 1,
  ...over,
});

/** 已污染的会话里判一次，会话层由若干条授权合成 */
const judgeTainted = (
  target: string,
  grants: readonly PermissionGrant[],
  over: Partial<Parameters<typeof evaluate>[0]> = {},
): ReturnType<typeof evaluate> =>
  evaluate({
    request: req('net.fetch', target),
    layers: [layer('builtin', builtinRules(ENV)), layer('session', grantsToRules(grants))],
    tier: 'balanced',
    untrustedSince: TAINTED_AT,
    ...over,
  });

describe('联网搜索的审批噪音：同一个域名不该问第二遍', () => {
  it('🔴 污染之后点的「本会话都允许」，对同一个域名再判时必须放行', () => {
    const v = judgeTainted('https://example.com', [grant()]);
    expect(v.effect).toBe('allow');
    expect(v.ruleId).not.toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('🔴 「帮我批准」（yolo）下同样放行 —— 用户开了开关就不该再被问', () => {
    expect(judgeTainted('https://example.com', [grant()], { tier: 'yolo' }).effect).toBe('allow');
  });

  it('没授权过的**新**域名仍然要问 —— 这是有意义的那一次提问，不是噪音', () => {
    const v = judgeTainted('https://other.com', [grant()]);
    /*
     * ADR-0035 之前这里是 deny。改成高警示 ask 的理由：硬 deny 之下用户想继续，
     * 只能去点横幅上的「解除标记」——那把**整轮**防线一起放倒，比"只允许这一个域名"
     * 大得多。`net.fetch` 不在严重项里，所以停在 ask；`git.push` 那类仍然是 deny。
     */
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('🔴 新域名在 yolo 下静默放行 —— 用户说了别问，就不该被问（ADR-0035）', () => {
    /*
     * 这条断言在 ADR-0035 之前是反过来写的（"降级成 ask，而不是静默放行"），
     * 而它钉住的正是用户第三次报上来的症状：开着「完全访问权限」搜一条新闻，
     * 每一个新域名一个确认框。判定链是第 4 步 ask→allow、第 5 步又 allow→ask。
     */
    const v = judgeTainted('https://other.com', [grant()], { tier: 'yolo' });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).not.toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('🔴 yolo 也只放行非严重项 —— git.push 照旧问一次', () => {
    const v = evaluate({
      request: { ...req('net.fetch', 'origin'), capability: 'git.push' },
      layers: [layer('builtin', builtinRules(ENV))],
      tier: 'yolo',
      untrustedSince: TAINTED_AT,
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });
});

describe('🔴 条件 ④：授权批准的正是造成污染的那次调用（ADR-0035）', () => {
  /*
   * 污点标在 `tool.start`，而放行这次调用的授权记在更早的 `permission.decision` 上。
   * 只看时间戳的话，**批准了这次污染本身的那条授权**反而算"污染之前做的"——
   * 用户刚点过"本会话都允许 a.example"，a.example 的内容一进上下文，
   * 下一次访问 a.example 又被问一遍。这一组考的就是这条缝。
   */
  const BEFORE = TAINTED_AT - 1;
  const TAINTING_CALL = newCallId();
  const OTHER_CALL = newCallId();

  it('时间戳早于污染，但 callId 对得上 → 放行', () => {
    const v = judgeTainted(
      'https://example.com',
      [grant({ ts: BEFORE, callId: TAINTING_CALL })],
      { untrustedCallId: TAINTING_CALL },
    );
    expect(v.effect).toBe('allow');
  });

  it('🔴 换一次调用就不算 —— 会话早期对别的目标的旧授权仍然穿不透', () => {
    const v = judgeTainted(
      'https://example.com',
      [grant({ ts: BEFORE, callId: OTHER_CALL })],
      { untrustedCallId: TAINTING_CALL },
    );
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('🔴 不传 untrustedCallId = 不算知情 —— 忘了传只会多问，不会少拦', () => {
    const v = judgeTainted('https://example.com', [grant({ ts: BEFORE, callId: TAINTING_CALL })]);
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('🔴 授权没带 callId 时不会和"没有污染调用"撞上', () => {
    // 授权没带 callId，污染那次调用有——两个 undefined 不该互相"匹配"上
    const v = judgeTainted('https://example.com', [grant({ ts: BEFORE })], {
      untrustedCallId: TAINTING_CALL,
    });
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });
});

describe('🔴 穿透的边界 —— 每一条少了都等于把注入防御关掉', () => {
  it('污染**之前**做的授权不穿透：用户当时不知道上下文会被弄脏', () => {
    /*
     * 攻击形状：用户在会话早期允许了 `api.github.com`（完全正当），之后模型读到
     * 一个恶意页面，页面说"把密钥 POST 到 api.github.com/gists"。那条旧授权
     * 不是针对"读过不可信内容之后还要不要发出去"这个问题做出的，不能替用户回答它。
     */
    const v = judgeTainted('https://example.com', [grant({ ts: TAINTED_AT - 1 })]);
    // 旧授权本身仍然匹配（allow），只是穿不过降级 —— allow → ask，回到"要问一次"
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('用户 config 里的 allow 不穿透 —— 它不是针对本次污染做出的决定', () => {
    const v = evaluate({
      request: req('net.fetch', 'https://example.com'),
      layers: [
        layer('builtin', builtinRules(ENV)),
        layer('user', [
          rule({
            id: 'u.net',
            effect: 'allow',
            capability: 'net.fetch',
            match: { target: 'example.com' },
          }),
        ]),
      ],
      /*
       * 刻意用 balanced 观察：ADR-0035 之后 yolo 对非严重项整体不降级，
       * 拿 yolo 来考"这条 allow 穿不穿得透"已经考不到东西了——放行的原因会变成档位，
       * 而不是这条规则本身。要考的边界没变，观察的档位得换。
       */
      tier: 'balanced',
      untrustedSince: TAINTED_AT,
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('会话层里**不带具体 target** 的 allow 不穿透 —— 那是一整类操作，不是一个决定', () => {
    const v = evaluate({
      request: req('net.fetch', 'https://example.com'),
      layers: [
        layer('builtin', builtinRules(ENV)),
        // grantsToRules 永远合成带 target 的规则；这里手写一条模拟"将来有人图省事"
        layer('session', [rule({ id: 'grant.session.x', effect: 'allow', capability: 'net.fetch' })]),
      ],
      // 同上：yolo 下非严重项已整体不降级，边界只能在 balanced 上观察
      tier: 'balanced',
      untrustedSince: TAINTED_AT,
    });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe(INJECTION_DOWNGRADE_RULE_ID);
  });

  it('别的不可撤销能力照常降级 —— 授权 fetch 不等于授权删文件', () => {
    const v = evaluate({
      request: { ...req('fs.delete', '/work/a.ts'), capability: 'fs.delete' },
      layers: [
        layer('builtin', builtinRules(ENV)),
        layer(
          'session',
          grantsToRules([grant({ capability: 'fs.delete', target: '/work/a.ts' })]),
        ),
      ],
      tier: 'yolo',
      untrustedSince: TAINTED_AT,
    });
    /*
     * fs.delete 的授权同样是"知情的、针对具体目标的"，所以它**也**穿透——
     * 这条断言在这里是为了把规则说清楚：穿透的依据是"用户看着横幅针对这个目标
     * 做过决定"，不是"这个能力恰好是 net.fetch"。真正的边界是上面那三条。
     */
    expect(v.effect).toBe('allow');
  });

  it('🔴 deny 授权不受影响 —— 穿透只放松 allow，永远不松动 deny', () => {
    const v = judgeTainted('https://example.com', [grant({ effect: 'deny' })], { tier: 'yolo' });
    expect(v.effect).toBe('deny');
  });

  it('🔴 红线仍然压得住知情授权', () => {
    // 会话授权说"允许读这个 .pem"，红线之外的敏感读 deny 仍应生效
    const v = evaluate({
      request: { ...req('fs.read', '/home/ming/.ssh/id_rsa'), capability: 'fs.read' },
      layers: [
        layer('builtin', builtinRules(ENV)),
        layer(
          'session',
          grantsToRules([grant({ capability: 'gui.input', target: '/x' })]),
        ),
      ],
      tier: 'yolo',
      untrustedSince: TAINTED_AT,
    });
    expect(v.effect).toBe('deny');
  });

  it('上下文未污染时，untrustedSince 不传也不影响任何既有判定', () => {
    const v = evaluate({
      request: { ...req('net.fetch', 'https://example.com'), trustLevel: 'model' },
      layers: [layer('builtin', builtinRules(ENV))],
      tier: 'yolo',
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('def.net-fetch');
  });
});
