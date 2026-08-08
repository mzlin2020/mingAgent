import { describe, expect, it } from 'vitest';
import type { MessageId, SessionId, XmEvent, XmEventType } from '@xm/contracts';
import { createEvent, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import type { LiveBuffer, SessionState } from '@xm/kernel';
import { EMPTY_LIVE, applyLive, emptySessionState, hasLive, reduce } from '@xm/kernel';

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
function feed(events: readonly XmEvent[]): { state: SessionState; live: LiveBuffer } {
  let state = emptySessionState(SESSION);
  let live = EMPTY_LIVE;
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
    expect(live.message?.text).toBe('你好呀');
  });

  it('思考与正文分开累积 —— UI 要把它们渲染成两种东西', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '让我想想', 'thinking'),
      delta(id, '答案是'),
      delta(id, '。', 'thinking'),
    ]);
    expect(live.message?.thinking).toBe('让我想想。');
    expect(live.message?.text).toBe('答案是');
  });

  it('不属于当前消息的 delta 一律丢弃 —— 订阅可以中途接上，"没看见开头"是正常情况', () => {
    const id = newMessageId();
    const other = newMessageId();
    const { live } = feed([start(id), delta(id, 'A'), delta(other, 'B')]);
    expect(live.message?.text).toBe('A');
  });

  it('没有 start 就来的 delta 不凭空造出一条消息', () => {
    const id = newMessageId();
    expect(applyLive(EMPTY_LIVE, delta(id, 'A')).message).toBeUndefined();
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
    expect(live.message).toBeUndefined();
    expect(textOf(state)).toBe('你好呀');
  });

  it('delta 拼出来的与 message.end 里的一致 —— ADR-0008 的包含性不变量，在 UI 这一层再验一次', () => {
    const id = newMessageId();
    const pieces = ['小明', '正在', '流式', '输出'];
    const full = pieces.join('');

    let live = EMPTY_LIVE;
    live = applyLive(live, start(id));
    for (const p of pieces) live = applyLive(live, delta(id, p));

    // 归零之前，buffer 里的内容必须**逐字**等于将要落库的那条消息
    expect(live.message?.text).toBe(full);
    expect(applyLive(live, end(id, full)).message).toBeUndefined();
  });

  it('message.interrupted 归零 —— 用户按了停止，在途内容不该继续挂在屏幕上', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '半句话'),
      ev('message.interrupted', { messageId: id, reason: 'aborted' }),
    ]);
    expect(live.message).toBeUndefined();
  });

  it('turn.end 兜底归零 —— 否则会留下一段永远不会被替换的文字', () => {
    const id = newMessageId();
    const { live } = feed([
      start(id),
      delta(id, '半句话'),
      ev('turn.end', { turnId: TURN, reason: 'error' }),
    ]);
    expect(live.message).toBeUndefined();
  });

  it('新消息开始时，上一条的在途内容让位', () => {
    const a = newMessageId();
    const b = newMessageId();
    const { live } = feed([start(a), delta(a, '第一条'), start(b), delta(b, '第二条')]);
    expect(live.message?.text).toBe('第二条');
  });
});

/**
 * ── 工具进度：满足同一条判据，但方式不同 ──
 *
 * `message.delta` 的文字最终**原样进** `message.end`，所以它是"先在 buffer、后在 state"。
 * `tool.progress` 的内容**永远不会进** state——持久流里对应的是 `tool.end` 的结果，
 * 那是另一段文字。所以它的判据是"随 `tool.end` 消失"，不是"被取代"。
 *
 * 这个区别值得单独测：写这一半的人很容易照抄上一半，把归零时机挂在
 * `message.end` 上——那样一次工具调用的进度会在模型说完话的那一刻消失，
 * 而工具那时才刚开始跑。
 */
describe('🔴 在途缓冲：工具进度', () => {
  const callId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never;

  const progress = (message: string): XmEvent =>
    ev('tool.progress', { callId, message }, false);
  const toolEnd = (): XmEvent =>
    ev('tool.end', { callId, ok: true, durationMs: 1, forModel: [{ type: 'text', text: '好了' }] });

  it('只留最新一条 —— 进度是"现在在干什么"，堆起来就成了日志', () => {
    const { live } = feed([progress('读第 1 个文件'), progress('读第 2 个文件')]);
    expect(live.calls.get(callId)?.message).toBe('读第 2 个文件');
    expect(live.calls.size).toBe(1);
  });

  it('tool.end 一到就删掉那一条 —— 结果已经进了 state.messages', () => {
    const { live, state } = feed([progress('跑着呢'), toolEnd()]);
    expect(live.calls.size).toBe(0);
    // 而结果确实在 state 里
    expect(JSON.stringify(state.messages)).toContain('好了');
  });

  it('归零时机挂的是 tool.end，不是 message.end —— 工具是在模型说完之后才开始跑的', () => {
    const id = newMessageId();
    const { live } = feed([start(id), delta(id, '这就去读'), end(id, '这就去读'), progress('读着呢')]);
    expect(live.message).toBeUndefined();
    expect(live.calls.get(callId)?.message).toBe('读着呢');
  });

  it('turn.end 兜底清掉所有还挂着的调用', () => {
    const { live } = feed([progress('跑着呢'), ev('turn.end', { turnId: TURN, reason: 'error' })]);
    expect(live.calls.size).toBe(0);
  });

  it('tool.progress 在 reduce 里仍然是空操作（ADR-0008）', () => {
    const before = emptySessionState(SESSION);
    expect(reduce(before, progress('x'))).toEqual(before);
  });
});

/**
 * ── PTY 会话：满足同一条判据，但归零时机又不一样 ──
 *
 * `message`/`calls` 都是"随本轮结束事件归零"，PTY 会话不是——它本来就是"打开一次、
 * 跨越多个 turn 持续存在"的东西（ADR-0031），`turn.end` 不该把它冲掉。
 */
describe('🔴 在途缓冲：PTY 会话（ADR-0031）', () => {
  const ptySessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never;

  const opened = (cwd = '/w'): XmEvent => ev('shell.session.opened', { ptySessionId, cwd, cols: 80, rows: 24 });
  const output = (chunk: string): XmEvent => ev('shell.session.output', { ptySessionId, chunk }, false);
  const closed = (): XmEvent =>
    ev('shell.session.closed', { ptySessionId, exitCode: 0, reason: 'exited', tail: '' });

  it('opened 建一条记录，output 逐块累积', () => {
    const { live } = feed([opened(), output('$ '), output('echo hi\n'), output('hi\n')]);
    const t = live.terminals.get(ptySessionId);
    expect(t?.text).toBe('$ echo hi\nhi\n');
    expect(t?.closed).toBe(false);
  });

  it('没看见 opened 就来的 output 不凭空造一条 —— 与 message.delta 同一个宽容度', () => {
    expect(applyLive(EMPTY_LIVE, output('x')).terminals.size).toBe(0);
  });

  it('closed 只标记，不删除 —— 用户关面板前，最后的输出还应该看得见', () => {
    const { live } = feed([opened(), output('done\n'), closed()]);
    const t = live.terminals.get(ptySessionId);
    expect(t?.closed).toBe(true);
    expect(t?.text).toBe('done\n');
  });

  it('turn.end 不清 PTY 会话 —— 它跨 turn 存活，这是与 message/calls 唯一的形状差异', () => {
    const { live } = feed([opened(), output('还在跑'), ev('turn.end', { turnId: TURN, reason: 'end_turn' })]);
    expect(live.terminals.get(ptySessionId)?.text).toBe('还在跑');
  });

  it('shell.session.output 在 reduce 里仍然是空操作（ADR-0008）', () => {
    const before = emptySessionState(SESSION);
    expect(reduce(before, output('x'))).toEqual(before);
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
    expect(hasLive(feed(persistedOnly).live)).toBe(false);
  });
});
