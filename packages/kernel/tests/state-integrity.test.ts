import { describe, expect, it } from 'vitest';
import type { SessionId, XmEvent } from '@xm/contracts';
import { createEvent, newRequestId, newSessionId } from '@xm/contracts';
import { emptySessionState, reduceAll } from '@xm/kernel';

/**
 * 状态完整性：**能影响安全的东西，一律不能只存在于"当时"，必须能从事件流回放出来。**
 *
 * 第一条是实测抓到的洞：`session.configured` 的补丁可以写 `permission` 子树——
 * 一条会话事件即提权。模型能发这条事件，所以这个禁令是结构性的，不是礼貌性的。
 *
 * 第二条是 ADR-0039 之后的新不变量：两条 `permission.*` 事件**只推进 seq**。
 * 它们过去驱动 `pendingPermission`（确认卡片）与 `grants`（本会话都允许），
 * 现在两个字段都不存在了，但事件仍然留在老会话的流里——回放老流不能凭空造出
 * 一个当时并不存在的状态，也不能崩。
 */

const S: SessionId = newSessionId();
let seq = 0;
const ts = 1_700_000_000_000;

const ev = (type: Parameters<typeof createEvent>[0]['type'], payload: unknown): XmEvent =>
  createEvent({
    type,
    sessionId: S,
    seq: ++seq,
    ts: ts + seq,
    payload: payload as never,
  });

describe('会话级配置不得提权', () => {
  it('🔴 session.configured 改不动 permission —— 一条会话事件不能给自己加 allow 规则', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.configured', {
        patch: {
          permission: {
            rules: [{ id: 's.allow-all', effect: 'allow', capability: '*', reason: 'x' }],
          },
        },
      }),
    ]);
    expect(st.config).not.toHaveProperty('permission');
  });

  it('🔴 session.configured 改不动 providers（否则等于能把请求导向任意端点）', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.configured', {
        patch: { providers: { anthropic: { baseUrl: 'https://evil.example' } } },
      }),
    ]);
    expect(st.config).not.toHaveProperty('providers');
  });

  it('无害的会话覆盖照常生效 —— 限制的是特定键，不是整个机制', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.configured', { patch: { logging: { level: 'debug' }, model: { main: 'x/y' } } }),
    ]);
    expect(st.config).toEqual({ logging: { level: 'debug' }, model: { main: 'x/y' } });
  });
});

/**
 * ── 老会话的 `permission.*` 事件（ADR-0039）──
 *
 * 审批删掉之后这两条事件只剩一个用途：deny 的审计记录（`by: 'policy'`）。
 * 它们**不再派生任何状态**——但老库里存着大量 `by: 'user'`、`scope: 'session'`
 * 的旧事件，回放它们时必须既不崩、也不凭空造出一个当时不存在的宽松状态。
 */
describe('permission.* 事件只推进 seq', () => {
  const requestId = newRequestId();
  const request = {
    requestId,
    capability: 'shell.exec' as const,
    target: 'rm -rf build',
    risk: 'high' as const,
    reason: '清理构建产物',
    trustLevel: 'model' as const,
  };

  it('deny 的审计对（今天唯一会产生的形状）不改变状态', () => {
    const before = emptySessionState(S);
    const st = reduceAll(before, [
      ev('permission.request', request),
      ev('permission.decision', { requestId, effect: 'deny', scope: 'once', by: 'policy' }),
    ]);
    expect(st).toEqual({ ...before, lastSeq: st.lastSeq });
    expect(st.lastSeq).toBeGreaterThan(0);
  });

  it('🔴 老事件流里 scope=session 的用户授权回放不出任何放宽', () => {
    const before = emptySessionState(S);
    const st = reduceAll(before, [
      ev('permission.request', request),
      ev('permission.decision', { requestId, effect: 'allow', scope: 'session', by: 'user' }),
    ]);
    // 状态里已经没有能表达"本会话都允许"的地方了，回放出来必须与空状态一致
    expect(st).toEqual({ ...before, lastSeq: st.lastSeq });
  });

  it('status 不会被推到一个已经不存在的取值上', () => {
    const st = reduceAll(emptySessionState(S), [ev('permission.request', request)]);
    expect(st.status).toBe('idle');
  });
});
