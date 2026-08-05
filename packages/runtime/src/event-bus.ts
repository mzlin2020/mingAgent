import type { AnyEvent, SessionId } from '@xm/contracts';

/**
 * 进程内事件总线。
 *
 * ── 为什么它在 runtime 而不在存储层 ──
 *
 * ADR-0013 不变量五：**存储不做发布订阅**。追加成功之后由 runtime 往总线上发，
 * 这样"谁通知"只有一个答案。若把通知放进存储，第二个进程就会想去轮询它，
 * 而轮询意味着它认为自己也能写——单写者不变量就是这么被一点点侵蚀的。
 *
 * ── `fromSeq` 续读 ──
 *
 * 订阅带 `fromSeq`，重连时从自己记得的位置续。这是"崩在追加与广播之间不丢事件"
 * 唯一需要的机制，也是 `seq` 无空洞这条不变量的直接用途（envelope.ts 规则 3）。
 * 总线**不缓存历史**：补齐缺口是订阅者拿 `fromSeq` 去 `EventStore.read()` 的事，
 * 让总线兼职缓存只会多出一份会过期的真相。
 */

export type EventListener = (event: AnyEvent) => void;

export interface Subscription {
  /** 已经推给该订阅者的最大 seq。重连时拿它当 `fromSeq` */
  readonly lastSeq: number;
  unsubscribe(): void;
}

interface Entry {
  readonly sessionId: SessionId | undefined;
  readonly listener: EventListener;
  lastSeq: number;
}

export class EventBus {
  readonly #entries = new Set<Entry>();

  /**
   * @param sessionId 只听某个会话；不传则听全部（UI 的会话列表要靠它感知新会话）
   */
  subscribe(listener: EventListener, sessionId?: SessionId): Subscription {
    const entry: Entry = { sessionId, listener, lastSeq: 0 };
    this.#entries.add(entry);
    const entries = this.#entries;
    return {
      get lastSeq() {
        return entry.lastSeq;
      },
      unsubscribe() {
        entries.delete(entry);
      },
    };
  }

  /**
   * 广播。**只能在 append 成功之后调用**（不变量五）。
   *
   * 一个订阅者抛错不影响其他订阅者：总线是通知渠道，不是执行链。
   * 让一个 UI 组件的渲染异常连累事件流，是那种查半天才发现的故障。
   */
  publish(event: AnyEvent): void {
    for (const entry of this.#entries) {
      if (entry.sessionId !== undefined && entry.sessionId !== event.sessionId) continue;
      entry.lastSeq = Math.max(entry.lastSeq, event.seq);
      try {
        entry.listener(event);
      } catch {
        // 见上。订阅者自己的错误由它自己负责
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
