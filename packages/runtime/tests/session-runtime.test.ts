import { describe, expect, it } from 'vitest';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { EventStore, SealedEvent, SessionWriter } from '@xm/kernel';
import { MemoryEventStore } from '@xm/kernel';
import { EventBus, SessionRuntime } from '@xm/runtime';

/**
 * 把 `append` 变成会失败的存储。
 *
 * 这是「广播必须排在落库之后」（ADR-0013 不变量五）唯一能被外部观测到的角度：
 * 只有当追加失败时，两种顺序才表现出差别。
 */
class FailingStore implements EventStore {
  readonly #inner = new MemoryEventStore();
  #failFrom = Number.MAX_SAFE_INTEGER;

  failFromSeq(seq: number): void {
    this.#failFrom = seq;
  }

  listSessions() {
    return this.#inner.listSessions();
  }

  read(sessionId: SessionId) {
    return this.#inner.read(sessionId);
  }

  async openForWrite(sessionId: SessionId): Promise<SessionWriter> {
    const inner = await this.#inner.openForWrite(sessionId);
    const failFrom = (): number => this.#failFrom;
    return {
      sessionId: inner.sessionId,
      get lastSeq() {
        return inner.lastSeq;
      },
      async append(events: readonly SealedEvent[]) {
        if (events.some((e) => e.seq >= failFrom())) {
          throw new Error('磁盘炸了');
        }
        await inner.append(events);
      },
      close: () => inner.close(),
    };
  }

  rebuildSummaries() {
    return this.#inner.rebuildSummaries();
  }

  close() {
    return this.#inner.close();
  }
}

describe('SessionRuntime', () => {
  /**
   * 反过来写（先广播再落库）在追加失败时会让订阅者看到一条并不存在的事件。
   * 而事件流是唯一真相——UI 上多出来一条永远回放不出来的消息，是那种
   * 用户报"它自己删了我的消息"、开发者查不出来的问题。
   */
  it('🔴 append 失败时不许广播 —— 广播排在落库之后（不变量五）', async () => {
    const store = new FailingStore();
    const bus = new EventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });
    expect(seen).toHaveLength(1);

    store.failFromSeq(2);
    await expect(
      runtime.record({
        type: 'notice.posted',
        payload: { level: 'info', code: 'x', message: '这条落不了库' },
      }),
    ).rejects.toThrow('磁盘炸了');

    expect(seen, '落库失败的事件绝不能出现在总线上').toHaveLength(1);
    expect(runtime.state.lastSeq, '状态也不该推进').toBe(1);
  });

  it('瞬态事件不占 seq，但照样广播', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });

    const delta = await runtime.record({
      type: 'message.delta',
      payload: { messageId: sessionId as unknown as never, blockIndex: 0, kind: 'text', text: 'hi' },
    });

    expect(delta.seq, '瞬态事件复用上一条持久事件的 seq').toBe(1);
    expect(runtime.state.lastSeq).toBe(1);
    expect(seen).toHaveLength(2);

    const stored: number[] = [];
    for await (const e of store.read(sessionId)) stored.push(e.seq);
    expect(stored, '瞬态事件不落库').toEqual([1]);
  });

  it('重新打开会话时从事件流回放状态', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();

    const first = await SessionRuntime.open({ sessionId, store, bus });
    await first.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1', title: '甲' },
    });
    await first.record({ type: 'session.renamed', payload: { title: '乙' } });
    await first.close();

    const second = await SessionRuntime.open({ sessionId, store, bus });
    expect(second.state.title).toBe('乙');
    expect(second.lastSeq).toBe(2);
    await second.close();
  });
});

describe('EventBus', () => {
  it('按会话过滤；不传 sessionId 则收全部', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const a = newSessionId();
    const b = newSessionId();

    const onlyA: AnyEvent[] = [];
    const all: AnyEvent[] = [];
    bus.subscribe((e) => onlyA.push(e), a);
    const allSub = bus.subscribe((e) => all.push(e));

    for (const s of [a, b]) {
      const rt = await SessionRuntime.open({ sessionId: s, store, bus });
      await rt.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'x/y' } });
      await rt.close();
    }

    expect(onlyA).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(allSub.lastSeq, 'lastSeq 是重连时的 fromSeq').toBe(1);
  });

  it('一个订阅者抛错不影响其他订阅者 —— 总线是通知渠道，不是执行链', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const ok: AnyEvent[] = [];
    bus.subscribe(() => {
      throw new Error('UI 渲染炸了');
    });
    bus.subscribe((e) => ok.push(e));

    const rt = await SessionRuntime.open({ sessionId: newSessionId(), store, bus });
    await rt.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'x/y' } });
    expect(ok).toHaveLength(1);
    await rt.close();
  });
});
