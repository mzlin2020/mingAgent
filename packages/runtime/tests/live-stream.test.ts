import { describe, expect, it } from 'vitest';
import type { AnyEvent, XmEvent } from '@xm/contracts';
import { isCoreEvent, newSessionId } from '@xm/contracts';
import type { LiveBuffer, SessionState } from '@xm/kernel';
import {
  MemoryEventStore,
  ToolRegistry,
  applyLive,
  builtinLayers,
  EMPTY_LIVE,
  hasLive,
  emptySessionState,
  reduce,
} from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * ── 流式渲染的**端到端**验证（G6 / ADR-0021）──
 *
 * 上一层（kernel/tests/live-buffer.test.ts）验的是 `applyLive` 这个纯函数对不对。
 * 这一层订的是总线，按渲染层**一模一样**的方式消费事件——`reduce` 一条线、
 * `applyLive` 一条线——然后检查两件事：
 *
 *   一、流式输出期间，屏幕上确实有字在长（G6 那个洞的正面证明）
 *   二、逐条 delta 拼出来的文本，与最终落库的 `message.end` **逐字一致**
 *
 * 第二条是 ADR-0008 的包含性不变量（*瞬态事件不得携带持久流中不存在的信息*）
 * 在真实 Turn 循环上的检查点。它一旦破了，用户会看到打字机打出一段字，
 * 然后在结束的瞬间被换成另一段——而事件流看起来完全正常。
 */

const ENV = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

const PIECES = ['小明', '正在', '流式', '输出', '一段', '话。'];
const FULL = PIECES.join('');

/** 按渲染层的方式消费：两条线各走各的（apps/desktop/src/renderer/store.ts） */
class Screen {
  state: SessionState;
  live: LiveBuffer = EMPTY_LIVE;
  /** 每次 live 更新时的快照，用来证明"字在长" */
  readonly frames: string[] = [];
  /** 逐条收到的 delta 文本 */
  readonly deltas: string[] = [];

  constructor(sessionId: ReturnType<typeof newSessionId>) {
    this.state = emptySessionState(sessionId);
  }

  apply(e: AnyEvent): void {
    if (!isCoreEvent(e)) return;
    const core: XmEvent = e;
    this.state = reduce(this.state, core);
    this.live = applyLive(this.live, core);
    if (core.type === 'message.delta' && core.payload.kind !== 'thinking') {
      this.deltas.push(core.payload.text);
      this.frames.push(this.live.message?.text ?? '');
    }
  }
}

async function run(): Promise<Screen> {
  const store = new MemoryEventStore();
  const bus = new EventBus();
  const sessionId = newSessionId();
  const screen = new Screen(sessionId);

  const runtime = await SessionRuntime.open({ sessionId, store, bus });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });

  // 订阅要在建会话之后：这里只关心一次流式回复
  bus.subscribe((e) => {
    screen.apply(e);
  }, sessionId);

  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              { kind: 'thinking_delta', text: '想一下…' },
              ...PIECES.map((text) => ({ kind: 'text_delta' as const, text })),
              { kind: 'stop', reason: 'end_turn' },
            ] as never,
          },
        ],
      }),
      tools: new ToolRegistry(),
      layers: builtinLayers(ENV),
      tier: 'balanced',
      model: 'scripted-1',
    },
    textInput('说点什么'),
  );

  await runtime.close();
  return screen;
}

describe('流式输出真的会显示出来', () => {
  it('🔴 delta 到达期间屏幕上的文字在逐条变长 —— 这就是 G6 那个洞的正面证明', async () => {
    const s = await run();

    expect(s.frames).toHaveLength(PIECES.length);
    expect(s.frames[0]).toBe(PIECES[0]);
    for (let i = 1; i < s.frames.length; i++) {
      expect(s.frames[i]!.startsWith(s.frames[i - 1]!), `第 ${String(i)} 帧`).toBe(true);
      expect(s.frames[i]!.length).toBeGreaterThan(s.frames[i - 1]!.length);
    }
    expect(s.frames.at(-1)).toBe(FULL);
  });

  it('🔴 逐条 delta 拼出来的，与最终落库的消息逐字一致（ADR-0008 包含性）', async () => {
    const s = await run();
    const finalText = s.state.messages
      .flatMap((m) => (m.role === 'assistant' ? m.blocks : []))
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('');

    expect(s.deltas.join('')).toBe(finalText);
    expect(finalText).toBe(FULL);
  });

  it('回合结束时在途缓冲已归零 —— 屏幕上那段文字只剩 messages 里那一份', async () => {
    const s = await run();
    expect(hasLive(s.live)).toBe(false);
  });
});
