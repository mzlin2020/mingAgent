import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCallId, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import { emptySessionState, reduce } from '@xm/kernel';
import { SqliteEventStore } from '@xm/storage';
import { EventBus, SessionRuntime, abandonOrphanedTurn, scanForOrphanedSessions } from '@xm/runtime';

/**
 * 崩溃恢复在**真实 SQLite**（不是 `MemoryEventStore`）上的验证。
 *
 * ── 这里能测到什么，不能测到什么 ──
 *
 * 能测：一段"写到一半、从未调用 `.close()`"的事件流落在真实文件库里，`scanForOrphanedSessions`
 * 能在**写锁仍被持有**的情况下正确扫描出来（只读，不 `openForWrite()`——不变量四），
 * 以及经过真实的 SQLite 序列化/反序列化往返之后，`abandonOrphanedTurn` 依然收敛出合法状态。
 *
 * 不能测：`write_leases` 表按死亡 PID 回收陈旧标记那条分支（`isProcessAlive()`，
 * `packages/storage/src/sqlite-event-store.ts`）。单个 vitest 进程里开两个 `SqliteEventStore`
 * 实例，`pid` 永远是同一个、永远"活着"——第二次 `openForWrite()` 只会正确地抛
 * `WriteLeaseError`（见下面那条用例），这本身没错，但它验证不了"进程真的死了之后
 * 陈旧标记被回收"。那条分支需要一个真正被 `SIGKILL` 的子进程，vitest 单进程测不到，
 * 现在由 `scripts/smoke-write-lease-recovery.mjs`（+ 姊妹脚本
 * `smoke-write-lease-recovery-child.mjs`）覆盖，见该脚本头部注释。
 */
describe('崩溃恢复：真实 SqliteEventStore', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('写锁仍被持有时，scanForOrphanedSessions 依然能读到孤儿（只读，不用抢锁）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xm-crash-'));
    const path = join(dir, 'events.sqlite3');
    const store = new SqliteEventStore({ path });
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });

    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: '列个目录' }] } });
    const callId = newCallId();
    const assistantMessageId = newMessageId();
    await dead.record({
      type: 'message.end',
      turnId,
      payload: {
        message: {
          id: assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } }],
          ts: Date.now(),
        },
      },
    });
    await dead.record({
      type: 'tool.start',
      turnId,
      payload: {
        callId,
        messageId: assistantMessageId,
        name: 'fs.list',
        input: { path: '/repo' },
        risk: 'safe',
        capabilities: ['fs.read'],
      },
    });
    // 没有 tool.end、没有 turn.end、没有 dead.close()——写锁还握在 `dead` 手里

    const found = await scanForOrphanedSessions(store);
    expect(found).toHaveLength(1);
    expect(found[0]!.orphan).toMatchObject({ turnId, kind: 'tool' });

    // 同一个会话再 openForWrite 会正确地撞上写锁——同一进程、同一 PID，
    // 结构上等价于"另一个还活着的进程"，理应拒绝，不是崩溃恢复要处理的情形
    await expect(SessionRuntime.open({ sessionId, store, bus: new EventBus() })).rejects.toThrow(/写句柄持有/);

    // 用持有锁的这个 runtime 自己收尾（对应生产路径里 runtimeFor() 复用同一个 runtime）
    const reason = await abandonOrphanedTurn(dead, found[0]!.orphan);
    expect(reason).toBe('aborted');
    await dead.close();
    await store.close();
  });

  it('放弃之后的状态经真实持久化往返仍然合法：新开一个 store 回放同样收敛', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xm-crash-'));
    const path = join(dir, 'events.sqlite3');

    const sessionId = newSessionId();
    {
      const store = new SqliteEventStore({ path });
      const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
      await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
      const turnId = newTurnId();
      await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: 'hi' }] } });
      const callId = newCallId();
      const assistantMessageId = newMessageId();
      await dead.record({
        type: 'message.end',
        turnId,
        payload: {
          message: {
            id: assistantMessageId,
            role: 'assistant',
            blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: {} }],
            ts: Date.now(),
          },
        },
      });
      await dead.record({
        type: 'tool.start',
        turnId,
        payload: { callId, messageId: assistantMessageId, name: 'fs.list', input: {}, risk: 'safe', capabilities: ['fs.read'] },
      });

      const found = await scanForOrphanedSessions(store);
      await abandonOrphanedTurn(dead, found[0]!.orphan);
      await dead.close();
      await store.close();
    }

    // 真正开一个全新的 SqliteEventStore 指向同一个文件——这是"重启"在测试里能做到的
    // 最接近的形式：新的 JS 对象、新的连接，只共享磁盘上的文件
    const reopened = new SqliteEventStore({ path });
    let replayed = emptySessionState(sessionId);
    for await (const e of reopened.read(sessionId)) replayed = reduce(replayed, e);

    expect(replayed.status).toBe('idle');
    expect(replayed.activeTurn).toBeUndefined();
    expect(replayed.runningCalls.size).toBe(0);
    expect(await scanForOrphanedSessions(reopened)).toEqual([]);
    await reopened.close();
  });
});
