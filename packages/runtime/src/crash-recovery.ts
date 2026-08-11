import type { CallId, ResultBlock, SessionId, StopReason } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type { DanglingToolUse, EventStore, OrphanedTurn, RunningCall } from '@xm/kernel';
import { deserializeSessionState, detectOrphanedTurn, emptySessionState, reduce } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

/**
 * 崩溃恢复（docs/04 §8，M1-e）。
 *
 * ── 为什么扫描是只读的，不抢排他标记 ──
 *
 * `EventStore` 的不变量四："写要先拿排他标记，读不用"。这里只调用 `listSessions()`/
 * `read()`/`readSnapshot()`，从不 `openForWrite()`——一次全量扫描不该跟仍然真的活着的
 * 另一个进程抢锁；真正需要写（合成收尾事件、决定继续/放弃）时，调用方会走
 * `SessionRuntime.open()` 那条会正常检测/抢占陈旧标记的路径（services.ts 的 runtimeFor）。
 */

export interface OrphanedSession {
  readonly sessionId: SessionId;
  readonly orphan: OrphanedTurn;
}

/** 起始扫描：对每个会话读 tail + reduce，找出停在没收尾回合里的那些。 */
export async function scanForOrphanedSessions(store: EventStore): Promise<readonly OrphanedSession[]> {
  const summaries = await store.listSessions();
  const results: OrphanedSession[] = [];

  for (const s of summaries) {
    const snapshot = await store.readSnapshot(s.sessionId);
    let state =
      snapshot === undefined ? emptySessionState(s.sessionId) : deserializeSessionState(snapshot.state);
    const fromSeq = snapshot === undefined ? undefined : { fromSeq: snapshot.seq + 1 };

    for await (const e of store.read(s.sessionId, fromSeq)) state = reduce(state, e);

    const orphan = detectOrphanedTurn(state);
    if (orphan !== undefined) results.push({ sessionId: s.sessionId, orphan });
  }

  return results;
}

/** 合成一条"这次调用没跑完"的 tool.end——ok:false，复用 ErrorCode.aborted（不新增枚举值）。 */
async function synthesizeToolEnd(runtime: SessionRuntime, turnId: OrphanedTurn['turnId'], callId: CallId, reason: string): Promise<void> {
  const forModel: ResultBlock[] = [{ type: 'text', text: reason }];
  await runtime.record({
    type: 'tool.end',
    turnId,
    payload: { callId, ok: false, durationMs: 0, forModel, error: xmError('aborted', reason) },
  });
}

async function synthesizeRunningCall(runtime: SessionRuntime, turnId: OrphanedTurn['turnId'], call: RunningCall): Promise<void> {
  await synthesizeToolEnd(
    runtime,
    turnId,
    call.callId,
    `工具 "${call.name}" 的这次调用没有跑完就中断了（进程意外退出，崩溃恢复补发）。`,
  );
}

async function synthesizeDangling(runtime: SessionRuntime, turnId: OrphanedTurn['turnId'], call: DanglingToolUse): Promise<void> {
  await synthesizeToolEnd(
    runtime,
    turnId,
    call.callId,
    `工具 "${call.name}" 的这次调用还没开始执行，回合就因为进程意外退出而中断了（崩溃恢复补发）。`,
  );
}

/**
 * 按 `orphan.kind` 补发缺失的收尾事件，让会话回到"每个 tool_use 都有 tool_result、
 * 没有悬空 activeMessage"的合法状态——`turn.end` 不清 `activeMessage`
 * （见 orphan.ts 顶部注释），不先补发就直接写 `turn.end` 会让此后任何一轮的
 * `messages` 都是畸形的。
 *
 * `'none'` 什么都不用做：崩在了迭代边界上，状态本来就合法。
 *
 * 这里曾经还有一个 `'permission'` 分支：进程死在一个待批的审批上，恢复时补一条
 * `effect: 'deny'` 的 decision（**中断按拒绝处理**）再给那次调用补 `tool_result`。
 * ADR-0039 之后判定不会挂起，那种孤儿在结构上不可能产生，分支随 `OrphanedTurn`
 * 的那个变体一起删除。
 */
export async function synthesizeInterruption(runtime: SessionRuntime, orphan: OrphanedTurn): Promise<void> {
  switch (orphan.kind) {
    case 'message':
      await runtime.record({
        type: 'message.interrupted',
        turnId: orphan.turnId,
        payload: { messageId: orphan.messageId, reason: 'crash' },
      });
      return;

    case 'tool':
      for (const call of orphan.calls) await synthesizeRunningCall(runtime, orphan.turnId, call);
      for (const call of orphan.danglingToolUses) await synthesizeDangling(runtime, orphan.turnId, call);
      return;

    case 'none':
      return;
  }
}

/**
 * 放弃：补发收尾事件，再写 `turn.end(reason:'aborted')`——与停止按钮完全同一套语义
 * （turn.ts `runTurn` 的 `finally`、services.ts 的 `interrupt()`），不需要新契约。
 */
export async function abandonOrphanedTurn(runtime: SessionRuntime, orphan: OrphanedTurn): Promise<StopReason> {
  await synthesizeInterruption(runtime, orphan);
  const reason: StopReason = 'aborted';
  await runtime.record({ type: 'turn.end', turnId: orphan.turnId, payload: { turnId: orphan.turnId, reason } });
  return reason;
}
