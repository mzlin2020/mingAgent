import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { XmEvent } from '@xm/contracts';
import {
  XmEvent as XmEventSchema,
  isCoreEvent,
  newEventId,
  newSessionId,
  newTurnId,
  parseStoredEvent,
} from '@xm/contracts';
import { emptySessionState, reduceAll } from '@xm/kernel';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/events/v1/basic-session.json', import.meta.url),
);

const fixture = (): XmEvent[] =>
  (JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown[])
    .map((r) => parseStoredEvent(r))
    .filter(isCoreEvent);

describe('reduce：fixture 会话归约出的状态', () => {
  const events = fixture();
  const state = reduceAll(emptySessionState(events[0]!.sessionId), events);

  it('会话元信息来自 session.created / session.renamed', () => {
    expect(state.cwd).toBe('/work/demo');
    expect(state.modelRef).toBe('anthropic/claude-opus-5');
    expect(state.title).toBe('演示会话');
  });

  it('回合结束后回到 idle 且无活跃回合', () => {
    expect(state.status).toBe('idle');
    expect(state.activeTurn).toBeUndefined();
  });

  it('消息流 = 用户输入 + 助手消息 + 工具结果', () => {
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const toolResult = state.messages[2]!.blocks[0]!;
    expect(toolResult.type).toBe('tool_result');
  });

  it('工具调用结束后不再有运行中的调用', () => {
    expect(state.runningCalls.size).toBe(0);
    expect(state.interruptedCalls).toHaveLength(0);
  });

  it('权限决定后清空待审批项', () => {
    expect(state.pendingPermission).toBeUndefined();
  });

  it('用量累计', () => {
    expect(state.usage.usage.inputTokens).toBe(1200);
    expect(state.usage.usage.cacheReadTokens).toBe(900);
    expect(state.usage.costUsd).toBeCloseTo(0.0132);
    expect(state.usage.turns).toBe(1);
  });

  it('notice 被保留——SecretStore 退化这类事必须留痕', () => {
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]!.code).toBe('secret_store.degraded');
  });

  it('checkpoint 记录在案', () => {
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]!.ref).toBe('abc1234');
    expect(state.checkpoints[0]!.restoredAt).toBeUndefined();
  });

  it('lastSeq 等于持久化事件条数', () => {
    expect(state.lastSeq).toBe(15);
  });
});

describe('reduce：崩溃与中断的可见性', () => {
  it('turn.end 时仍在跑的工具调用被记为 interrupted', () => {
    const events = fixture();
    // 去掉 tool.end，模拟"工具还没返回，回合就结束了"
    const withoutToolEnd = events.filter((e) => e.type !== 'tool.end');
    const state = reduceAll(emptySessionState(events[0]!.sessionId), withoutToolEnd);

    expect(state.runningCalls.size).toBe(0);
    expect(state.interruptedCalls).toHaveLength(1);
    expect(state.interruptedCalls[0]!.name).toBe('fs.list');
  });

  it('并行的多个工具结果合并进同一条 user 消息', () => {
    const events = fixture();
    const at = events.findIndex((e) => e.type === 'tool.end');
    const second = events[at]!;
    const withTwo = [...events.slice(0, at + 1), second, ...events.slice(at + 1)];

    const state = reduceAll(emptySessionState(events[0]!.sessionId), withTwo);

    const buckets = state.messages.filter(
      (m) => m.role === 'user' && m.blocks.every((b) => b.type === 'tool_result'),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.blocks).toHaveLength(2);
  });
});

describe('reduce：lastError 不能是一条永远挂着的横幅', () => {
  const sessionId = newSessionId();
  let seq = 0;
  const ev = (type: XmEvent['type'], payload: unknown): XmEvent =>
    XmEventSchema.parse({
      id: newEventId(),
      sessionId,
      seq: ++seq,
      ts: 1_754_300_000_000 + seq,
      type,
      payload,
    });

  it('error.raised 写入 lastError', () => {
    const turnId = newTurnId();
    const events = [
      ev('session.created', { cwd: '/w', modelRef: 'anthropic/x' }),
      ev('turn.start', { turnId, input: [{ type: 'text', text: 'hi' }] }),
      ev('error.raised', {
        error: { code: 'provider_error', message: '出错了', retryable: false },
        fatal: false,
      }),
      ev('turn.end', { turnId, reason: 'error' }),
    ];
    const state = reduceAll(emptySessionState(sessionId), events);
    expect(state.lastError?.message).toBe('出错了');
  });

  it('🔴 下一轮 turn.start 清掉它——否则一次失败之后往后一百轮都成功，横幅还挂着', () => {
    const turnId1 = newTurnId();
    const turnId2 = newTurnId();
    const events = [
      ev('session.created', { cwd: '/w', modelRef: 'anthropic/x' }),
      ev('turn.start', { turnId: turnId1, input: [{ type: 'text', text: 'hi' }] }),
      ev('error.raised', {
        error: { code: 'provider_error', message: '出错了', retryable: false },
        fatal: false,
      }),
      ev('turn.end', { turnId: turnId1, reason: 'error' }),
      ev('turn.start', { turnId: turnId2, input: [{ type: 'text', text: '再试一次' }] }),
    ];
    const state = reduceAll(emptySessionState(sessionId), events);
    expect(state.lastError).toBeUndefined();
  });
});
