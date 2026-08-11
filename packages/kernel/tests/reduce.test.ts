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

/**
 * 真正的崩溃形状：进程被杀，**连 `turn.end` 都没有**——上面那组用例只去掉了
 * `tool.end`，`turn.end` 还在，那是"工具挂了但回合正常收尾"，不是崩溃恢复要处理的
 * 情形。这里连 `turn.end` 一起去掉，验证 `reduce()` 老老实实停在半路，
 * 不做任何"自动迁移"——迁移是崩溃恢复扫描时 `detectOrphanedTurn()` 的活，不是
 * `reduce()` 的活（reduce() 无法区分"还在跑"和"进程已经死了"，见 orphan.ts 的注释）。
 */
describe('reduce：真崩溃形状（无 turn.end）', () => {
  const upTo = (type: XmEvent['type'], nth = 1): XmEvent[] => {
    const events = fixture();
    let seen = 0;
    const at = events.findIndex((e) => {
      if (e.type !== type) return false;
      seen += 1;
      return seen === nth;
    });
    return events.slice(0, at + 1);
  };

  it('停在 message.start：activeMessage 挂着，status 仍是 running', () => {
    const events = upTo('message.start');
    const state = reduceAll(emptySessionState(events[0]!.sessionId), events);

    expect(state.status).toBe('running');
    expect(state.activeTurn).toBeDefined();
    expect(state.activeMessage).toBeDefined();
    expect(state.runningCalls.size).toBe(0);
    expect(state.interruptedCalls, 'reduce 不自动迁移——没有 turn.end 就没有 interruptedCalls').toHaveLength(0);
  });

  it('停在 tool.start：runningCalls 挂着一个调用，不会被误判成 interrupted', () => {
    const events = upTo('tool.start');
    const state = reduceAll(emptySessionState(events[0]!.sessionId), events);

    expect(state.status).toBe('running');
    expect(state.activeTurn).toBeDefined();
    expect(state.runningCalls.size).toBe(1);
    expect([...state.runningCalls.values()][0]!.name).toBe('fs.list');
    expect(state.interruptedCalls).toHaveLength(0);
  });

  /*
   * ADR-0039：`permission.request` 不再让会话进入任何"挂着"的状态——判定不会停下等人，
   * 所以停在这条事件上与停在两条事件之间没有区别，回合仍然是"在跑"。
   */
  it('停在 permission.request：会话仍然是 running，没有挂起态', () => {
    const events = upTo('permission.request');
    const state = reduceAll(emptySessionState(events[0]!.sessionId), events);

    expect(state.status).toBe('running');
    expect(state.activeTurn).toBeDefined();
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
