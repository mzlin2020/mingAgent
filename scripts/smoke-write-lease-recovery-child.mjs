/**
 * 被杀的一方（M1-e，补 ADR-0032/崩溃恢复的已知缺口）。
 *
 * 单独成文件是因为它要被 `spawn(['node', thisFile, ...])` 启动，不能是父进程里
 * 的一个内联函数——`isProcessAlive()` 那条分支需要**真正的两个操作系统进程**，
 * 同一个 vitest 进程里造两个 `SqliteEventStore` 实例测不出来（见
 * `apps/desktop/tests/crash-restart.test.ts` 头部注释）。
 *
 * 用法：`node scripts/smoke-write-lease-recovery-child.mjs <dbPath> <sessionId>`
 *
 * 走生产代码路径（`SessionRuntime.record()`）落一个真实的、`kind:'message'` 的
 * 孤儿事件流（`session.created` → `turn.start` → `message.start`，刻意不写
 * `message.end`），打印一行 marker 后就此挂起，直到被父进程 `SIGKILL`。
 */
import process from 'node:process';

import { newMessageId, newTurnId } from '../packages/contracts/dist/index.js';
import { SqliteEventStore } from '../packages/storage/dist/index.js';
import { EventBus, SessionRuntime } from '../packages/runtime/dist/index.js';

const [, , dbPath, sessionId] = process.argv;
if (dbPath === undefined || sessionId === undefined) {
  console.error('用法：node smoke-write-lease-recovery-child.mjs <dbPath> <sessionId>');
  process.exit(1);
}

const store = new SqliteEventStore({ path: dbPath });
const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });

await runtime.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
const turnId = newTurnId();
await runtime.record({
  type: 'turn.start',
  turnId,
  payload: { turnId, input: [{ type: 'text', text: '写个 todolist' }] },
});
await runtime.record({
  type: 'message.start',
  turnId,
  payload: { messageId: newMessageId(), role: 'assistant', model: 'scripted-1' },
});
// 没有 message.end、没有 turn.end——写锁停在这里，直到被 SIGKILL

console.log('LEASE_READY');
await new Promise(() => {
  /* 挂起，等父进程杀掉这个进程 */
});
