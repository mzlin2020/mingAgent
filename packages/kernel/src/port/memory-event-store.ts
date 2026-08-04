import type { PersistedEvent, SessionId } from '@xm/contracts';
import type { EventStore, ReadOptions, SealedEvent, SessionSummary, SessionWriter } from './event-store.js';
import { SeqConflictError, WriteLeaseError } from './event-store.js';
import { applyToSummary, buildSummary, initialSummary } from './summary-projection.js';

/**
 * 内存事件存储 —— 端口的**参考实现**。
 *
 * 它不是玩具：headless 冒烟、评测回放、以及每一个需要"一个真实会话"的单元测试都用它，
 * 而这些场景都不该碰文件系统。全部结构都是 Map 与数组，内核零 I/O 的约束照旧成立。
 *
 * 它同时是 `eventStoreContract()` 的第一个通过者——先让契约在一个能完全掌控的实现上跑通，
 * SQLite 适配器落地那天才有一个"已知正确"的对照物。反过来说：**这里能过、SQLite 过不了的，
 * 一定是 SQLite 的问题；两边都过不了的，是契约本身写错了。**
 */
interface Cell {
  readonly events: SealedEvent[];
  summary: SessionSummary;
}

export class MemoryEventStore implements EventStore {
  readonly #cells = new Map<SessionId, Cell>();
  readonly #leases = new Set<SessionId>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSessions(): Promise<readonly SessionSummary[]> {
    return [...this.#cells.values()]
      .map((c) => c.summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *read(sessionId: SessionId, options?: ReadOptions): AsyncIterable<PersistedEvent> {
    const from = options?.fromSeq ?? 1;
    const to = options?.toSeq ?? Number.MAX_SAFE_INTEGER;
    // 会话不存在 = 空序列，不抛（见端口注释）
    for (const e of this.#cells.get(sessionId)?.events ?? []) {
      if (e.seq >= from && e.seq <= to) yield e;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async openForWrite(sessionId: SessionId): Promise<SessionWriter> {
    if (this.#leases.has(sessionId)) {
      throw new WriteLeaseError(
        `会话 ${sessionId} 已被另一个写者持有。同一会话只允许一个写者（ADR-0013 不变量四）。`,
      );
    }
    this.#leases.add(sessionId);

    const cell: Cell = this.#cells.get(sessionId) ?? {
      events: [],
      summary: initialSummary(sessionId),
    };
    this.#cells.set(sessionId, cell);

    let open = true;
    const leases = this.#leases;

    return {
      sessionId,
      get lastSeq() {
        return cell.summary.lastSeq;
      },

      // eslint-disable-next-line @typescript-eslint/require-await
      async append(events: readonly SealedEvent[]): Promise<void> {
        if (!open) {
          throw new WriteLeaseError(`会话 ${sessionId} 的写句柄已关闭。`);
        }
        if (events.length === 0) return;

        // ── 先全量校验，再整批写入。原子性就是这么来的（不变量一）──
        let expected = cell.summary.lastSeq + 1;
        for (const e of events) {
          if (e.sessionId !== sessionId) {
            throw new SeqConflictError(sessionId, expected, e.seq);
          }
          if (e.seq !== expected) {
            throw new SeqConflictError(sessionId, expected, e.seq);
          }
          expected += 1;
        }
        const first = events[0];
        if (cell.summary.lastSeq === 0 && first !== undefined && first.type !== 'session.created') {
          throw new Error(
            `会话 ${sessionId} 的首条事件是 "${first.type}"，必须是 session.created。` +
              `没有它，会话就没有 cwd 与模型引用，回放不出可用状态。`,
          );
        }

        let summary = cell.summary;
        for (const e of events) {
          cell.events.push(e);
          summary = applyToSummary(summary, e);
        }
        // 摘要与事件在同一步落定 —— 对应适配器里的"同一个事务"
        cell.summary = summary;
      },

      // eslint-disable-next-line @typescript-eslint/require-await
      async close(): Promise<void> {
        open = false;
        leases.delete(sessionId);
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rebuildSummaries(): Promise<void> {
    for (const [sessionId, cell] of this.#cells) {
      cell.summary = buildSummary(sessionId, cell.events);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this.#leases.clear();
  }
}
