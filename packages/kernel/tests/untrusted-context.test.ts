import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, XmEvent } from '@xm/contracts';
import {
  UNTRUSTED_CONTENT_CAPABILITIES,
  isUntrustedContentSource,
  newCallId,
  newEventId,
  newMessageId,
  newRequestId,
  newSessionId,
  newTurnId,
} from '@xm/contracts';
import { builtinRules, emptySessionState, evaluate, reduce, reduceAll } from '@xm/kernel';
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
 * ── 上下文污染标记：本项目第七次「规则存在 ≠ 规则生效」的回归闸门 ──
 *
 * M0-b 复审实测：`PermissionRequest.trustLevel` 在整个代码库里只被赋值过一次，
 * 硬编码在 `runtime/src/turn.ts` 里，值恒为 `'model'`。后果是三条 `red.*-untrusted`
 * 红线与整套注入降级（allow→ask、ask→deny）**从写下起一次也没有触发过**：
 *
 *   trustLevel=untrusted + git.push → DENY [builtin.injection-downgrade]   ← 设计意图
 *   trustLevel=model     + git.push → ASK  [def.git-push]                  ← 实际唯一可达
 *
 * 判定逻辑是对的，测试是绿的，防御是不存在的。docs/06 §9 的验收项
 * "读过网页后要求 git push → 从 ask 变 deny" 因此永远不可能通过。
 *
 * 修法的要点不是"补一处赋值"，而是**让它没有可以被忘记的地方**：
 * trustLevel 现在从事件流算出来（reduce 的 tool.start 分支读 payload.capabilities），
 * 工具只要如实声明 `net.fetch` 就自动生效。下面的用例盯的就是这条链子。
 */

const SESSION = newSessionId();
let seq = 0;

const ev = (type: string, payload: unknown): XmEvent =>
  ({
    id: newEventId(),
    sessionId: SESSION,
    seq: ++seq,
    ts: 1_700_000_000_000 + seq,
    type,
    v: 1,
    payload,
  }) as unknown as XmEvent;

const created = () => ev('session.created', { cwd: '/w', modelRef: 'anthropic/x' });

const toolStart = (name: string, capabilities: Capability[]) =>
  ev('tool.start', {
    callId: newCallId(),
    messageId: newMessageId(),
    name,
    input: {},
    risk: 'medium',
    capabilities,
  });

describe('不可信内容源的能力子集', () => {
  it('闭集选得住：会话不会因为日常操作被永久污染', () => {
    // fs.read 在平衡档默认放行且几乎每轮都发生。把它算进来 = 会话一开始就永久不可信
    // = 用户直接关掉整道防御 = 真的没有防御。
    expect(isUntrustedContentSource('fs.read')).toBe(false);
    expect(isUntrustedContentSource('shell.exec')).toBe(false);
  });

  it('闭集选得全：换条路进来的同一段载荷也要算', () => {
    // 截屏截的如果是浏览器窗口，和 net.fetch 拿回来的是同一段攻击载荷
    expect(UNTRUSTED_CONTENT_CAPABILITIES).toContain('net.fetch');
    expect(UNTRUSTED_CONTENT_CAPABILITIES).toContain('browser.control');
    expect(UNTRUSTED_CONTENT_CAPABILITIES).toContain('gui.capture');
  });
});

describe('reduce：污点由事件流算出', () => {
  it('干净会话没有标记', () => {
    const s = reduceAll(emptySessionState(SESSION), [
      created(),
      toolStart('fs.read', ['fs.read']),
    ]);
    expect(s.untrustedContext).toBeUndefined();
  });

  it('跑过 net.fetch 之后置上标记，并留下出处', () => {
    const s = reduceAll(emptySessionState(SESSION), [
      created(),
      toolStart('web.fetch', ['net.fetch']),
    ]);
    expect(s.untrustedContext?.viaCapability).toBe('net.fetch');
    expect(s.untrustedContext?.toolName).toBe('web.fetch');
  });

  it('标记是粘性的：跨回合不清除', () => {
    // 注入最自然的形状就是跨回合——这一轮读网页，下一轮再让你 push。
    // 按回合清空等于"上一轮读的网页这一轮不算数了"，防御刚好在攻击路径上失效。
    const s = reduceAll(emptySessionState(SESSION), [
      created(),
      toolStart('web.fetch', ['net.fetch']),
      ev('turn.end', { turnId: newTurnId(), reason: 'end_turn' }),
      ev('turn.start', { turnId: newTurnId(), input: [{ type: 'text', text: '现在 push' }] }),
    ]);
    expect(s.untrustedContext).toBeDefined();
  });

  it('标记在回放中可复现 —— 它是算出来的，不是记在内存里的', () => {
    const events = [created(), toolStart('web.fetch', ['net.fetch'])];
    const live = reduceAll(emptySessionState(SESSION), events);
    // 关掉应用重开 = 从 seq 1 重新 reduce 一遍。标记必须原样回来，否则
    // "重启一下注入标记就没了" 是个一句话绕过。
    const replayed = reduceAll(emptySessionState(SESSION), events);
    expect(replayed.untrustedContext).toEqual(live.untrustedContext);
  });

  it('标记不被后续干净调用冲掉', () => {
    let s = reduceAll(emptySessionState(SESSION), [created(), toolStart('web.fetch', ['net.fetch'])]);
    const first = s.untrustedContext;
    s = reduce(s, toolStart('fs.read', ['fs.read']));
    expect(s.untrustedContext).toEqual(first);
  });
});

describe('端到端：污点接上判定，docs/06 §9 的验收项', () => {
  const ENV: PolicyEnv = {
    home: '/home/ming',
    appRoot: '/repo',
    dataDir: '/home/ming/.local/share/xiaoming',
  };
  const RULES = builtinRules(ENV);

  const ask = (capability: Capability, target: string, trustLevel: 'model' | 'untrusted') =>
    judge({
      request: {
        requestId: newRequestId(),
        sessionId: SESSION,
        capability,
        target,
        risk: 'high',
        reason: '测试',
        trustLevel,
      } satisfies PermissionRequest,
      rules: RULES,
      tier: 'balanced',
    });

  // 这就是 turn.ts 现在做的事：状态里有没有标记，决定请求里填什么
  const trustOf = (s: { untrustedContext: unknown }) =>
    s.untrustedContext === undefined ? ('model' as const) : ('untrusted' as const);

  it('读过网页之后，git.push 从 ask 变 deny', () => {
    const clean = reduceAll(emptySessionState(SESSION), [created()]);
    expect(ask('git.push', '/repo', trustOf(clean)).effect).toBe('ask');

    const tainted = reduce(clean, toolStart('web.fetch', ['net.fetch']));
    const v = ask('git.push', '/repo', trustOf(tainted));
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('builtin.injection-downgrade');
  });

  it('读过网页之后，读密钥命中红线', () => {
    const tainted = reduceAll(emptySessionState(SESSION), [
      created(),
      toolStart('web.fetch', ['net.fetch']),
    ]);
    const v = ask('secrets.read', 'anthropic', trustOf(tainted));
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.secrets-read-untrusted');
  });

  it('可撤销的操作不被降级 —— 全局收紧会被用户整体关掉', () => {
    const tainted = reduceAll(emptySessionState(SESSION), [
      created(),
      toolStart('web.fetch', ['net.fetch']),
    ]);
    expect(ask('fs.read', '/repo/a.ts', trustOf(tainted)).effect).toBe('allow');
  });
});
