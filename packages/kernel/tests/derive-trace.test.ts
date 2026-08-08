import { describe, expect, it } from 'vitest';
import type { SessionId, XmEvent } from '@xm/contracts';
import { createEvent, newCallId, newRequestId, newSessionId, newTurnId } from '@xm/contracts';
import { deriveTraces } from '@xm/kernel';
import { sampleEvents } from './helpers/sample-events.js';

/**
 * L0 trace 派生（ADR-0032 #4）。
 *
 * 这里的用例刻意手搭事件而不是全部依赖 `sampleEvents()`——`deriveTraces` 关心的是
 * **跨事件的时序关系**（哪个 tool.end 配哪个 tool.start、turn 中途被打断算什么），
 * 这类东西用"每种类型一条样本"测不出来，需要真的按顺序摆一段小剧本。
 */

const S: SessionId = newSessionId();
let seq = 0;
const BASE_TS = 1_700_000_000_000;

const ev = (type: Parameters<typeof createEvent>[0]['type'], payload: unknown, tsOffset = 0): XmEvent =>
  createEvent({
    type,
    sessionId: S,
    seq: ++seq,
    ts: BASE_TS + tsOffset,
    payload: payload as never,
  });

describe('deriveTraces：正常的一个 turn', () => {
  it('工具调用、用量、结束原因全部正确归到同一条 trace', () => {
    const turnId = newTurnId();
    const callId = newCallId();

    const events = [
      ev('turn.start', { turnId, input: [{ type: 'text', text: '读一下这个文件' }] }, 0),
      ev('tool.start', { callId, messageId: newTurnId(), name: 'fs.read', input: { path: 'a.txt' }, risk: 'safe', capabilities: [] }, 10),
      ev('tool.end', { callId, ok: true, durationMs: 42, forModel: [{ type: 'text', text: 'ok' }] }, 60),
      ev('usage.recorded', { turnId, provider: 'anthropic', model: 'claude-x', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01 }, 70),
      ev('turn.end', { turnId, reason: 'end_turn' }, 100),
    ];

    const [trace] = deriveTraces(events);
    expect(trace).toBeDefined();
    expect(trace?.traceId).toBe(turnId);
    expect(trace?.sessionId).toBe(S);
    expect(trace?.ts).toBe(BASE_TS);
    expect(trace?.model).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(trace?.steps).toEqual([
      { kind: 'tool', callId, name: 'fs.read', input: { path: 'a.txt' }, ok: true, ms: 42 },
    ]);
    expect(trace?.outcome).toEqual({ stopReason: 'end_turn', costUsd: 0.01, wallMs: 100 });
    expect(trace?.feedback).toEqual({ interrupted: false, rejectedPermissions: 0 });
  });

  it('多次 usage.recorded 的 costUsd 累加；model 只记第一次见到的', () => {
    const turnId = newTurnId();
    const events = [
      ev('turn.start', { turnId, input: [] }, 0),
      ev('usage.recorded', { turnId, provider: 'anthropic', model: 'a', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01 }, 10),
      ev('usage.recorded', { turnId, provider: 'anthropic', model: 'b', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.02 }, 20),
      ev('turn.end', { turnId, reason: 'end_turn' }, 30),
    ];

    const [trace] = deriveTraces(events);
    expect(trace?.outcome.costUsd).toBeCloseTo(0.03);
    expect(trace?.model).toEqual({ provider: 'anthropic', model: 'a' });
  });
});

describe('deriveTraces：被打断/未结束的 turn', () => {
  it('message.interrupted 但随后仍有 turn.end：stopReason 以 turn.end 为准，feedback.interrupted=true', () => {
    const turnId = newTurnId();
    const events = [
      ev('turn.start', { turnId, input: [] }, 0),
      ev('message.interrupted', { messageId: newTurnId(), reason: 'aborted' }, 10),
      ev('turn.end', { turnId, reason: 'aborted' }, 20),
    ];

    const [trace] = deriveTraces(events);
    expect(trace?.outcome.stopReason).toBe('aborted');
    expect(trace?.feedback.interrupted).toBe(true);
  });

  it('🔴 窗口结束时 turn.start 没有配对的 turn.end：如实产出不完整的 trace，不丢弃', () => {
    const turnId = newTurnId();
    const events = [ev('turn.start', { turnId, input: [] }, 0)];

    const traces = deriveTraces(events);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.outcome.stopReason).toBe('unknown');
    expect(traces[0]?.outcome.wallMs).toBeUndefined();
  });

  it('未配对的 turn.start 且出现过 message.interrupted：stopReason 记 interrupted 不是 unknown', () => {
    const turnId = newTurnId();
    const events = [
      ev('turn.start', { turnId, input: [] }, 0),
      ev('message.interrupted', { messageId: newTurnId(), reason: 'crash' }, 10),
    ];

    const [trace] = deriveTraces(events);
    expect(trace?.outcome.stopReason).toBe('interrupted');
  });

  it('还没等到 tool.end 就被打断的调用：不出现在 steps 里（没有 durationMs 可用，不假装知道）', () => {
    const turnId = newTurnId();
    const callId = newCallId();
    const events = [
      ev('turn.start', { turnId, input: [] }, 0),
      ev('tool.start', { callId, messageId: newTurnId(), name: 'shell.exec', input: {}, risk: 'high', capabilities: ['shell.exec'] }, 10),
      ev('turn.end', { turnId, reason: 'aborted' }, 20),
    ];

    const [trace] = deriveTraces(events);
    expect(trace?.steps).toEqual([]);
  });
});

describe('deriveTraces：权限拒绝计数', () => {
  it('只数 effect === "deny"，allow 不计入', () => {
    const turnId = newTurnId();
    const events = [
      ev('turn.start', { turnId, input: [] }, 0),
      ev('permission.decision', { requestId: newRequestId(), effect: 'deny', scope: 'once', by: 'policy' }, 10),
      ev('permission.decision', { requestId: newRequestId(), effect: 'allow', scope: 'once', by: 'user' }, 20),
      ev('permission.decision', { requestId: newRequestId(), effect: 'deny', scope: 'session', by: 'user' }, 30),
      ev('turn.end', { turnId, reason: 'end_turn' }, 40),
    ];

    const [trace] = deriveTraces(events);
    expect(trace?.feedback.rejectedPermissions).toBe(2);
  });
});

describe('deriveTraces：多个 turn 顺序独立', () => {
  it('两个连续的 turn 派生出两条独立的 trace，互不串数据', () => {
    const turnA = newTurnId();
    const turnB = newTurnId();
    const events = [
      ev('turn.start', { turnId: turnA, input: [] }, 0),
      ev('usage.recorded', { turnId: turnA, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 1 }, 10),
      ev('turn.end', { turnId: turnA, reason: 'end_turn' }, 20),
      ev('turn.start', { turnId: turnB, input: [] }, 30),
      ev('usage.recorded', { turnId: turnB, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 2 }, 40),
      ev('turn.end', { turnId: turnB, reason: 'end_turn' }, 50),
    ];

    const traces = deriveTraces(events);
    expect(traces).toHaveLength(2);
    expect(traces[0]?.traceId).toBe(turnA);
    expect(traces[0]?.outcome.costUsd).toBe(1);
    expect(traces[1]?.traceId).toBe(turnB);
    expect(traces[1]?.outcome.costUsd).toBe(2);
  });
});

describe('deriveTraces：可回放（docs/07 L0 达成的验收标准）', () => {
  it('🔴 纯函数：同一段事件跑两遍产出完全相同的 trace', () => {
    const turnId = newTurnId();
    const callId = newCallId();
    const events = [
      ev('turn.start', { turnId, input: [{ type: 'text', text: 'x' }] }, 0),
      ev('tool.start', { callId, messageId: newTurnId(), name: 'fs.read', input: {}, risk: 'safe', capabilities: [] }, 10),
      ev('tool.end', { callId, ok: true, durationMs: 5, forModel: [] }, 20),
      ev('turn.end', { turnId, reason: 'end_turn' }, 30),
    ];

    const once = deriveTraces(events);
    const again = deriveTraces(events);
    expect(again).toEqual(once);
  });

  it('覆盖全部事件类型的样本（sampleEvents()）能被派生而不抛错，且产出至少一条 trace', () => {
    // 不断言具体字段——sampleEvents() 的职责是穷尽事件类型，不是模拟一个真实剧本。
    // 这里只确认 deriveTraces 对"每一种事件类型都可能出现在同一段流里"这件事是健壮的。
    expect(() => deriveTraces(sampleEvents())).not.toThrow();
    expect(deriveTraces(sampleEvents()).length).toBeGreaterThan(0);
  });
});
