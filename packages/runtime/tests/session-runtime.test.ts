import { describe, expect, it } from 'vitest';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { EventStore, ReadOptions, SealedEvent, SessionWriter, StateSnapshot } from '@xm/kernel';
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

  readSnapshot(sessionId: SessionId) {
    return this.#inner.readSnapshot(sessionId);
  }

  writeSnapshot(sessionId: SessionId, snapshot: Parameters<EventStore['writeSnapshot']>[1]) {
    return this.#inner.writeSnapshot(sessionId, snapshot);
  }

  close() {
    return this.#inner.close();
  }
}

/**
 * 只用来偷看 `read()` 被调用时的 `fromSeq`——验证"快照命中之后只补读尾部"
 * 这件事发生在存储调用层面，不是靠推断回放出的状态"看起来正确"就默认它。
 */
class ReadSpyStore implements EventStore {
  readonly #inner: EventStore;
  readCalls = 0;
  lastFromSeq: number | undefined;

  constructor(inner: EventStore) {
    this.#inner = inner;
  }

  listSessions() {
    return this.#inner.listSessions();
  }

  read(sessionId: SessionId, options?: ReadOptions) {
    this.readCalls += 1;
    this.lastFromSeq = options?.fromSeq;
    return this.#inner.read(sessionId, options);
  }

  openForWrite(sessionId: SessionId) {
    return this.#inner.openForWrite(sessionId);
  }

  rebuildSummaries() {
    return this.#inner.rebuildSummaries();
  }

  readSnapshot(sessionId: SessionId) {
    return this.#inner.readSnapshot(sessionId);
  }

  writeSnapshot(sessionId: SessionId, snapshot: StateSnapshot) {
    return this.#inner.writeSnapshot(sessionId, snapshot);
  }

  close() {
    return this.#inner.close();
  }
}

/** `writeSnapshot` 总是失败，其余全部委托给内层。 */
class SnapshotWriteFailingStore implements EventStore {
  readonly #inner: EventStore;

  constructor(inner: EventStore) {
    this.#inner = inner;
  }

  listSessions() {
    return this.#inner.listSessions();
  }

  read(sessionId: SessionId, options?: ReadOptions) {
    return this.#inner.read(sessionId, options);
  }

  openForWrite(sessionId: SessionId) {
    return this.#inner.openForWrite(sessionId);
  }

  rebuildSummaries() {
    return this.#inner.rebuildSummaries();
  }

  readSnapshot(sessionId: SessionId) {
    return this.#inner.readSnapshot(sessionId);
  }

  writeSnapshot(): Promise<void> {
    return Promise.reject(new Error('磁盘满了'));
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

  it('🔴 每 500 条持久事件存一份快照（ADR-0032，修 G4：会话回放超线性）', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const rt = await SessionRuntime.open({ sessionId, store, bus });

    await rt.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'x/y' } });
    expect(
      await store.readSnapshot(sessionId),
      '还没到 500 条持久事件，不该有快照',
    ).toBeUndefined();

    for (let i = 0; i < 499; i += 1) {
      await rt.record({ type: 'notice.posted', payload: { level: 'info', code: 'n', message: String(i) } });
    }
    // 到这里正好 1（session.created） + 499 = 500 条
    expect(rt.lastSeq).toBe(500);

    const snap = await store.readSnapshot(sessionId);
    expect(snap, '满 500 条应该已经存了一份快照').toBeDefined();
    expect(snap?.seq).toBe(500);
    await rt.close();
  });

  it('重新打开时若已有快照，只从快照之后补读尾部事件，不是从 1 开始全量回放（ADR-0032，修 G4）', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();

    const first = await SessionRuntime.open({ sessionId, store, bus });
    await first.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'x/y', title: '甲' },
    });
    for (let i = 0; i < 499; i += 1) {
      await first.record({ type: 'notice.posted', payload: { level: 'info', code: 'n', message: String(i) } });
    }
    const snap = await store.readSnapshot(sessionId);
    expect(snap?.seq).toBe(500);

    // 快照之后再记一条——重开时这一条必须靠回放补上，不能只信快照
    await first.record({ type: 'session.renamed', payload: { title: '乙' } });
    await first.close();

    const spy = new ReadSpyStore(store);
    const second = await SessionRuntime.open({ sessionId, store: spy, bus });

    expect(spy.readCalls, '应该真的调用了 read() 去补尾部，不是只读快照就完事').toBeGreaterThan(0);
    expect(spy.lastFromSeq, '应该从 snapshot.seq + 1 开始读，不是从 1').toBe(501);
    // 状态本身必须与"从头全量回放"完全一致——快照只是加速手段，不能改变结果
    expect(second.state.title).toBe('乙');
    expect(second.state.cwd).toBe('/w');
    expect(second.lastSeq).toBe(501);
    await second.close();
  });

  it(
    '🔴 快照写入失败：记一条 notice.posted 且不炸调用方，不会无限递归（防重入闸门）',
    async () => {
      const store = new SnapshotWriteFailingStore(new MemoryEventStore());
      const bus = new EventBus();
      const sessionId = newSessionId();
      const rt = await SessionRuntime.open({ sessionId, store, bus });

      await rt.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'x/y' } });
      // 跑满 500 条：如果没有 #snapshotting 防重入闸门，第 500 条这一次 record()
      // 会在 writeSnapshot 失败后触发 notice.posted → 又是一条持久事件 → 再次
      // 检查阈值（此时差值仍 ≥ 500）→ 再次尝试快照 → 再次失败 → 再发通知……
      // 这条用例本身能跑完、不超时/不栈溢出，就是防重入闸门生效的证据。
      for (let i = 0; i < 499; i += 1) {
        await rt.record({ type: 'notice.posted', payload: { level: 'info', code: 'n', message: String(i) } });
      }

      // 失败被如实记成一条 notice（内核/运行时不许 console.error，日志走事件流）
      expect(rt.state.notices.some((n) => n.code === 'snapshot_write_failed')).toBe(true);
      // 事件本身没有受影响：lastSeq 照常推进，会话仍然可用
      expect(rt.state.lastSeq).toBeGreaterThanOrEqual(500);
      await rt.close();
    },
    10_000,
  );
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
