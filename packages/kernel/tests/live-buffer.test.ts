import { describe, expect, it } from 'vitest';
import type { MessageId, SessionId, XmEvent, XmEventType } from '@xm/contracts';
import { createEvent, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import type { LiveBuffer, SessionState } from '@xm/kernel';
import { applyLive, emptyLiveBuffer, emptySessionState, reduce } from '@xm/kernel';

/**
 * ── 流式渲染与「第二份状态」的边界（docs/09 G6，ADR-0021）──
 *
 * 两条各自正确的约束合起来产生的洞：`message.delta` 在 `reduce` 里是空操作（ADR-0008），
 * 而渲染层不持有第二份状态（ADR-0015）——于是模型正在输出的文字一个字都显示不出来。
 *
 * live buffer 是补这个洞的东西，而它必须**证明自己不是被禁掉的那种第二份状态**。
 * 判据是可执行的一条：
 *
 *   **任何时刻，同一段文字要么在 buffer 里，要么在 state.messages 里，不会同时在两边。**
 *
 * 下面每一条用例都围着这条判据转。
 */

const SESSION: SessionId = newSessionId();
const TURN = newTurnId();

let seq = 0;
const ev = (type: XmEventType, payload: unknown, bump = true): XmEvent =>
  createEvent({
    type,
    sessionId: SESSION,
    seq: bump ? ++seq : Math.max(seq, 1),
    ts: 1_754_300_000_000 + seq,
    turnId: TURN,
    payload: payload as never,
  });

const start = (messageId: MessageId): XmEvent =>
  ev('message.start', { messageId, role: 'assistant' });

/** 瞬态事件不推进 seq —— 与 SessionRuntime 的约定一致 */
const delta = (messageId: MessageId, text: string, kind: 'text' | 'thinking' = 'text'): XmEvent =>
  ev('message.delta', { messageId, blockIndex: 0, kind, text }, false);

const end = (messageId: MessageId, text: string): XmEvent =>
  ev('message.end', {
    message: {
      id: messageId,
      role: 'assistant',
      ts: 1,
      blocks: [{ type: 'text', text }],
    },
  });

const textOf = (state: SessionState): string =>
  state.messages
    .flatMap((m) => m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
    .join('');

/** 同时喂两条线，模拟渲染层的 `applyEvent` */
function feed(events: readonly XmEvent[]): { state: SessionState; live: LiveBuffer | undefined } {
  let state = emptySessionState(SESSION);
  let live = emptyLiveBuffer();
  for (const e of events) {
    state = reduce(state, e);
    live = applyLive(live, e);
  }
  return { state, live };
}

describe('在途缓冲：累积', () => {
  it('delta 逐条累进来，start 之后 end 之前都看得见', () => {
    const id = newMessageId();
    const { live } = feed([start(id), delta(id, '你'), delta(id, '好'), delta(id, '呀')]);
    expect(live?.text).toBe('你好呀');
  });

  it('思考与正文分开累积 —— UI 要把它们渲染成两种东西', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '让我想想', 'thinking'),
      delta(id, '答案是'),
      delta(id, '。', 'thinking'),
    ]);
    expect(live?.thinking).toBe('让我想想。');
    expect(live?.text).toBe('答案是');
  });

  it('不属于当前消息的 delta 一律丢弃 —— 订阅可以中途接上，"没看见开头"是正常情况', () => {
    const id = newMessageId();
    const other = newMessageId();
    const { live } = feed([start(id), delta(id, 'A'), delta(other, 'B')]);
    expect(live?.text).toBe('A');
  });

  it('没有 start 就来的 delta 不凭空造出一条消息', () => {
    const id = newMessageId();
    expect(applyLive(emptyLiveBuffer(), delta(id, 'A'))).toBeUndefined();
  });
});

describe('🔴 在途缓冲：归零 —— 它凭什么不是"第二份状态"', () => {
  it('message.end 一到就归零，那段文字只在 state.messages 里出现一次', () => {
    const id = newMessageId();
    const { state, live } = feed([
      start(id),
      delta(id, '你好'),
      delta(id, '呀'),
      end(id, '你好呀'),
    ]);
    expect(live).toBeUndefined();
    expect(textOf(state)).toBe('你好呀');
  });

  it('delta 拼出来的与 message.end 里的一致 —— ADR-0008 的包含性不变量，在 UI 这一层再验一次', () => {
    const id = newMessageId();
    const pieces = ['小明', '正在', '流式', '输出'];
    const full = pieces.join('');

    let live = emptyLiveBuffer();
    live = applyLive(live, start(id));
    for (const p of pieces) live = applyLive(live, delta(id, p));

    // 归零之前，buffer 里的内容必须**逐字**等于将要落库的那条消息
    expect(live?.text).toBe(full);
    expect(applyLive(live, end(id, full))).toBeUndefined();
  });

  it('message.interrupted 归零 —— 用户按了停止，在途内容不该继续挂在屏幕上', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '半句话'),
      ev('message.interrupted', { messageId: id, reason: 'aborted' }),
    ]);
    expect(live).toBeUndefined();
  });

  it('turn.end 兜底归零 —— 否则会留下一段永远不会被替换的文字', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '半句话'),
      ev('turn.end', { turnId: TURN, reason: 'error' }),
    ]);
    expect(live).toBeUndefined();
  });

  it('新消息开始时，上一条的在途内容让位', () => {
    const a = newMessageId();
    const b = newMessageId();
    const { live } = feed([start(a), delta(a, '第一条'), start(b), delta(b, '第二条')]);
    expect(live?.text).toBe('第二条');
  });
});

describe('两条线互不干扰', () => {
  it('applyLive 不碰 SessionState，reduce 不碰 buffer —— message.delta 仍然是空操作', () => {
    const id = newMessageId();
    const before = reduce(emptySessionState(SESSION), start(id));
    const after = reduce(before, delta(id, '增量'));
    // ADR-0008 的硬不变量：瞬态事件不得改变状态的任何一位，包括 lastSeq
    expect(after).toEqual(before);
  });

  it('回放持久化流（没有 delta）得到的 messages 与带 delta 的一模一样', () => {
    const id = newMessageId();
    const withDeltas = [start(id), delta(id, '你'), delta(id, '好'), end(id, '你好')];
    const persistedOnly = withDeltas.filter((e) => e.type !== 'message.delta');

    // 崩溃恢复、重开会话走的是右边那条路。两边不一致，就是"刷新一下内容就变了"
    expect(textOf(feed(persistedOnly).state)).toBe(textOf(feed(withDeltas).state));
    expect(feed(persistedOnly).live).toBeUndefined();
  });
});
