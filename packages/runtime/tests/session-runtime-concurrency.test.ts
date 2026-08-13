import { describe, expect, it } from 'vitest';
import type { AnyEvent } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import { MemoryEventStore, SeqConflictError } from '@xm/kernel';
import { EventBus, SessionRuntime } from '@xm/runtime';

/**
 * `record()` 的并发安全（ADR-0038 前置）。
 *
 * ── 为什么这组用例存在 ──
 *
 * `record()` 是全系统唯一分配 `seq` 的地方，而它在**读 `#state.lastSeq`** 与
 * **写 `#state`** 之间隔着 `await this.#writer.append()`：
 *
 *     seq = nextSeq(this.#state.lastSeq)        ← 读
 *     await this.#writer.append([...])          ← 让出（存储已提交，#state 还没更新）
 *     this.#state = reduce(this.#state, event)  ← 写
 *
 * `MemoryEventStore.append` 与 `SqliteEventStore` 的 `appendTx` 都是 **async 声明、
 * 体内全同步**，所以那一拍里第二个写者读到的是陈旧的 `lastSeq`，算出同一个 seq，
 * 于是被存储的并发写检测器（`PRIMARY KEY(session_id, seq)` + 显式校验）判为
 * `SeqConflictError` 整条打回。
 *
 * 这不是自动命名引入的：`services.ts` 的 PTY `emit` 已经在踩它——
 * `shell.session.opened`/`closed` 是持久事件，撞上回合中的写入就被那句
 * `console.error('写入 shell.session 事件失败：', err)` 吞掉，会话里从此少一条
 * "终端关了"的事实。自动命名只是把一个偶发缺陷变成常态（每个会话的第一条消息
 * 都会有第二个写者），所以必须先关掉它。
 *
 * ── 为什么修法是串行化而不是重试 ──
 *
 * 端口不变量三（`packages/kernel/src/port/event-store.ts`）写死了：
 * "冲突即抛 `SeqConflictError`，**不重试、不重新分配**——那意味着有第二个写者，
 * 静默补救会把一次事故变成一段永远查不清的历史"。所以补救只能发生在分配 seq
 * 的那一侧：让临界区真的成为临界区。
 */

const CREATED = {
  type: 'session.created',
  payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
} as const;

const notice = (message: string) =>
  ({ type: 'notice.posted', payload: { level: 'info', code: 'x', message } }) as const;

describe('SessionRuntime 的并发写入', () => {
  /**
   * 反向演练的"改之前会失败"那一半。
   *
   * **确定性，不靠时序运气**：两次 `record()` 在同一个同步栈里发出，第一次的
   * `append` 在返回前就已经把 seq=2 落定，而它的 `#state` 更新排在一个微任务
   * 之后——第二次调用此刻读到的 `lastSeq` 必然还是 1。
   */
  it('🔴 同步栈里连发两次 record() —— 串行化之前必然 seq 冲突', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const rt = await SessionRuntime.open({ sessionId, store, bus });
    await rt.record(CREATED);

    const seen: AnyEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    // 两次都不 await，模拟"回合在写事件的同时，后台任务也写了一条"
    const first = rt.record(notice('甲'));
    const second = rt.record(notice('乙'));
    const results = await Promise.allSettled([first, second]);

    expect(
      results.every((r) => r.status === 'fulfilled'),
      '两条 record 都该成功——任何一条被 SeqConflictError 打回，都意味着有事实永久丢失',
    ).toBe(true);
    expect(
      results.some((r) => r.status === 'rejected' && r.reason instanceof SeqConflictError),
      '不该有 SeqConflictError',
    ).toBe(false);

    const stored: number[] = [];
    for await (const e of store.read(sessionId)) stored.push(e.seq);
    expect(stored, 'seq 必须连续无空洞').toEqual([1, 2, 3]);
    expect(rt.state.lastSeq).toBe(3);

    expect(
      seen.map((e) =>
        e.type === 'notice.posted' ? (e.payload as { message: string }).message : e.type,
      ),
      '广播顺序必须等于调用顺序',
    ).toEqual(['甲', '乙']);

    await rt.close();
  });

  /**
   * 串行化不能把"一条写失败"传染给后面排队的写入：`#tail` 上挂的是一条
   * 永不 rejected 的链，失败只属于发起那次调用的调用方。
   */
  it('前一次 record 失败，不连累后一次', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const rt = await SessionRuntime.open({ sessionId, store, bus });
    await rt.record(CREATED);

    // 无效 payload 会在 sealEvent 的统一校验出口失败；失败不能毒死写入队列。
    const doomed = rt.record({ type: 'session.renamed', payload: { title: 42 } } as never);
    const survivor = rt.record(notice('我该活下来'));

    await expect(doomed).rejects.toThrow();
    await expect(survivor).resolves.toMatchObject({ seq: 2 });
    expect(rt.state.lastSeq).toBe(2);

    await rt.close();
  });

  /**
   * `close()` 必须**先关门后排干**：已经排进链里的写入是既成事实，
   * 丢掉它等于"应用退出时静默吃掉最后一条事件"。
   */
  it('close() 把已排队的写入写完，之后的 record 才拒绝', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const rt = await SessionRuntime.open({ sessionId, store, bus });
    await rt.record(CREATED);

    const queued = rt.record(notice('排队中'));
    await rt.close();
    await expect(queued, '排队中的写入不该被 close 丢掉').resolves.toMatchObject({ seq: 2 });

    const stored: number[] = [];
    for await (const e of store.read(sessionId)) stored.push(e.seq);
    expect(stored).toEqual([1, 2]);

    await expect(rt.record(notice('太晚了'))).rejects.toThrow(/运行时已关闭/u);
  });
});
