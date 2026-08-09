import { describe, expect, it } from 'vitest';
import { newCallId, newMessageId, newRequestId, newSessionId, newTurnId } from '@xm/contracts';
import type { Message, PermissionRequest } from '@xm/contracts';
import { detectOrphanedTurn, emptySessionState } from '@xm/kernel';
import type { RunningCall, SessionState } from '@xm/kernel';

const sessionId = newSessionId();
const base = (): SessionState => emptySessionState(sessionId);

const runningCall = (): RunningCall => ({
  callId: newCallId(),
  name: 'fs.list',
  startedAt: 1,
  messageId: newMessageId(),
  input: { path: '/work' },
});

const permissionRequest = (callId = newCallId()): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId,
  callId,
  capability: 'fs.write',
  target: '/work/a.ts',
  risk: 'medium',
  reason: '写文件',
  trustLevel: 'model',
});

describe('detectOrphanedTurn', () => {
  it('没有 activeTurn：空闲会话不是孤儿', () => {
    expect(detectOrphanedTurn(base())).toBeUndefined();
  });

  it("有 activeTurn 但什么都没挂着：kind === 'none'", () => {
    const turnId = newTurnId();
    const state = { ...base(), activeTurn: { turnId, startedAt: 1 } };
    expect(detectOrphanedTurn(state)).toEqual({ turnId, kind: 'none' });
  });

  it("activeMessage 挂着：kind === 'message'", () => {
    const turnId = newTurnId();
    const messageId = newMessageId();
    const state = {
      ...base(),
      activeTurn: { turnId, startedAt: 1 },
      activeMessage: { messageId, role: 'assistant' as const, model: 'x/y', startedAt: 1 },
    };
    expect(detectOrphanedTurn(state)).toEqual({ turnId, kind: 'message', messageId });
  });

  it("runningCalls 非空：kind === 'tool'，带上全部孤儿调用，无遗留批内调用时 danglingToolUses 为空", () => {
    const turnId = newTurnId();
    const call = runningCall();
    const state = {
      ...base(),
      activeTurn: { turnId, startedAt: 1 },
      runningCalls: new Map([[call.callId, call]]),
    };
    expect(detectOrphanedTurn(state)).toEqual({
      turnId,
      kind: 'tool',
      calls: [call],
      danglingToolUses: [],
    });
  });

  it("pendingPermission 挂着：kind === 'permission'", () => {
    const turnId = newTurnId();
    const req = permissionRequest();
    const state = { ...base(), activeTurn: { turnId, startedAt: 1 }, pendingPermission: req };
    expect(detectOrphanedTurn(state)).toEqual({
      turnId,
      kind: 'permission',
      requestId: req.requestId,
      callId: req.callId,
      danglingToolUses: [],
    });
  });

  it('判定顺序：message 优先于 tool 优先于 permission（今天的 dispatchCall 是顺序执行，三者理论上互斥，但顺序仍要有确定的优先级）', () => {
    const turnId = newTurnId();
    const call = runningCall();
    const req = permissionRequest();
    const messageId = newMessageId();
    const state = {
      ...base(),
      activeTurn: { turnId, startedAt: 1 },
      activeMessage: { messageId, role: 'assistant' as const, model: 'x/y', startedAt: 1 },
      runningCalls: new Map([[call.callId, call]]),
      pendingPermission: req,
    };
    expect(detectOrphanedTurn(state)).toMatchObject({ kind: 'message' });
  });

  /**
   * 一批并行 tool_use 里，"卡住的那个"之后的调用连 permission.request 都没发过——
   * dispatchCall 是顺序执行的（turn.ts），第 3 个调用根本没轮到。这类调用要能从
   * 最后一条 assistant 消息的 tool_use 块里识别出来，否则续跑时喂给模型的上一条
   * assistant 消息会有一个 tool_use 找不到匹配的 tool_result（Anthropic API 硬错误）。
   */
  describe('danglingToolUses：批里没轮到的调用', () => {
    const assistantMessageWithThreeCalls = (calls: readonly { id: string; name: string }[]): Message => ({
      id: newMessageId(),
      role: 'assistant',
      blocks: calls.map((c) => ({ type: 'tool_use' as const, id: c.id as never, name: c.name, input: {} })),
      ts: 1,
    });

    it('第 2 个调用卡在权限审批：第 3 个调用没有 tool.start/tool_result，被识别为 dangling', () => {
      const turnId = newTurnId();
      const [first, second, third] = [newCallId(), newCallId(), newCallId()];
      const assistant = assistantMessageWithThreeCalls([
        { id: first, name: 'fs.read' },
        { id: second, name: 'fs.write' },
        { id: third, name: 'fs.write' },
      ]);
      // 第 1 个调用已经完事：它的结果进了紧跟在 assistant 消息后面的那条 user 消息
      const resultBucket: Message = {
        id: newMessageId(),
        role: 'user',
        blocks: [{ type: 'tool_result', toolUseId: first, content: [], isError: false }],
        ts: 2,
      };
      const req = permissionRequest(second);
      const state = {
        ...base(),
        activeTurn: { turnId, startedAt: 1 },
        messages: [assistant, resultBucket],
        pendingPermission: req,
      };

      const orphan = detectOrphanedTurn(state);
      expect(orphan).toMatchObject({ kind: 'permission', requestId: req.requestId, callId: second });
      if (orphan?.kind !== 'permission') throw new Error('expected permission-kind orphan');
      expect(orphan.danglingToolUses).toEqual([{ callId: third, name: 'fs.write', input: {} }]);
    });

    it('批里只有一个调用：没有遗留，danglingToolUses 为空', () => {
      const turnId = newTurnId();
      const call = runningCall();
      const assistant = assistantMessageWithThreeCalls([{ id: call.callId, name: call.name }]);
      const state = {
        ...base(),
        activeTurn: { turnId, startedAt: 1 },
        messages: [assistant],
        runningCalls: new Map([[call.callId, call]]),
      };
      const orphan = detectOrphanedTurn(state);
      expect(orphan).toMatchObject({ kind: 'tool', danglingToolUses: [] });
    });
  });
});
