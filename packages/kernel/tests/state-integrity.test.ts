import { describe, expect, it } from 'vitest';
import type { SessionId, XmEvent } from '@xm/contracts';
import { createEvent, newRequestId, newSessionId } from '@xm/contracts';
import { emptySessionState, reduceAll } from '@xm/kernel';

/**
 * 状态完整性：**能影响安全的东西，一律不能只存在于"当时"，必须能从事件流回放出来。**
 *
 * 这里两条都是实测抓到的洞：
 *   · `session.config` 的补丁可以设 `permission.tier = 'yolo'` —— 一条会话事件即提权
 *   · `permission.decision(scope=session)` 只清空 pendingPermission，决定本身不落状态
 *     —— 回放出来的会话看不出用户授权过什么
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
  it('🔴 session.config 改不动 permission.tier', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.config', { patch: { permission: { tier: 'yolo' } } }),
    ]);
    expect(st.config).not.toHaveProperty('permission');
  });

  it('🔴 session.config 改不动 providers（否则等于能把请求导向任意端点）', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.config', {
        patch: { providers: { anthropic: { baseUrl: 'https://evil.example' } } },
      }),
    ]);
    expect(st.config).not.toHaveProperty('providers');
  });

  it('无害的会话覆盖照常生效 —— 限制的是特定键，不是整个机制', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('session.config', { patch: { logging: { level: 'debug' }, model: { main: 'x/y' } } }),
    ]);
    expect(st.config).toEqual({ logging: { level: 'debug' }, model: { main: 'x/y' } });
  });
});

describe('权限决定必须可回放', () => {
  const requestId = newRequestId();
  const request = {
    requestId,
    capability: 'shell.exec' as const,
    target: 'rm -rf build',
    risk: 'high' as const,
    reason: '清理构建产物',
    trustLevel: 'model' as const,
  };

  it('🔴 scope=session 的授权进入状态', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('permission.request', request),
      ev('permission.decision', { requestId, effect: 'allow', scope: 'session', by: 'user' }),
    ]);
    expect(st.pendingPermission).toBeUndefined();
    expect(st.grants).toHaveLength(1);
    expect(st.grants[0]).toMatchObject({
      capability: 'shell.exec',
      target: 'rm -rf build',
      effect: 'allow',
      scope: 'session',
    });
  });

  it('🔴 拒绝同样留痕 —— 只记允许，回放出的状态就偏松', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('permission.request', request),
      ev('permission.decision', { requestId, effect: 'deny', scope: 'session', by: 'user' }),
    ]);
    expect(st.grants[0]).toMatchObject({ effect: 'deny' });
  });

  it('scope=once 不留痕 —— 它只对这一次调用有效', () => {
    const st = reduceAll(emptySessionState(S), [
      ev('permission.request', request),
      ev('permission.decision', { requestId, effect: 'allow', scope: 'once', by: 'user' }),
    ]);
    expect(st.grants).toHaveLength(0);
  });
});
