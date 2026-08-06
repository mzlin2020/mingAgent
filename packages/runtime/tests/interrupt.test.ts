import { describe, expect, it } from 'vitest';
import type { AnyEvent, ModelChunk, ModelRequest, XmEventType } from '@xm/contracts';
import { isCoreEvent, newSessionId } from '@xm/contracts';
import type { AbortLike, ModelCapabilities, ModelInfo, ModelProvider } from '@xm/kernel';
import { MemoryEventStore, ToolRegistry, builtinRules, emptySessionState, reduce } from '@xm/kernel';
import { EventBus, SessionRuntime, runTurn } from '@xm/runtime';

/**
 * 停止按钮的端到端验证 —— 闭合 ADR-0021 留下的「没人发 message.interrupted」。
 *
 * ── 这里守的是一条很容易写反的不变量 ──
 *
 * 直觉的做法是"中断时只发 `message.interrupted`"。那样 `message.delta` 已经把文字
 * 推给了订阅者（屏幕上打出来了），而持久流里没有任何事件包含它——**ADR-0008 的
 * 包含性不变量当场破掉**，表现是用户看着打字机打出半句话，重开会话后那半句凭空消失。
 *
 * 所以正确的形状是两条事件：先 `message.end`（带已到达的部分），再 `message.interrupted`。
 */

const ENV = { home: '/home/ming', appRoot: '/repo', dataDir: '/home/ming/.local/share/xiaoming' };

/**
 * 吐几个 chunk 之后就**永远挂住**的 Provider —— 模型正卡在长思考里的那种情况。
 *
 * 这是取消用例唯一有意义的形状：只要上游还在源源不断吐字，"循环里检查 aborted"
 * 的实现也能过关；挂住之后才分得出真停与假停。
 */
class HangingProvider implements ModelProvider {
  readonly id = 'hanging';
  /** 挂住之前先吐这些。写成显式字段而不是参数属性——`erasableSyntaxOnly` 禁掉了后者 */
  readonly prefix: readonly ModelChunk[];

  constructor(prefix: readonly ModelChunk[]) {
    this.prefix = prefix;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([]);
  }
  capabilities(): ModelCapabilities {
    return {
      tools: false, parallelTools: false, vision: false, documents: false,
      thinking: false, promptCache: false, maxContext: 1000, maxOutput: 100,
    };
  }

  async *stream(_req: ModelRequest, signal: AbortLike): AsyncIterable<ModelChunk> {
    for (const c of this.prefix) yield c;

    // 真 Provider 在这里是"fetch 的正文读取被 abort 掀翻"，形状一致：抛出去
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  }
}

interface Recorded {
  readonly types: XmEventType[];
  readonly deltas: string[];
  readonly persistedText: string;
  readonly elapsed: number;
  readonly reason: string;
}

async function runAndInterrupt(afterMs = 0): Promise<Recorded> {
  const store = new MemoryEventStore();
  const bus = new EventBus();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'hanging/x' },
  });

  const types: XmEventType[] = [];
  const deltas: string[] = [];
  bus.subscribe((e: AnyEvent) => {
    if (!isCoreEvent(e)) return;
    types.push(e.type);
    if (e.type === 'message.delta') deltas.push(e.payload.text);
  }, sessionId);

  const controller = new AbortController();
  const started = Date.now();

  const turn = runTurn(
    {
      runtime,
      provider: new HangingProvider([
        { kind: 'text_delta', text: '我正在' },
        { kind: 'text_delta', text: '慢慢地想…' },
      ]),
      tools: new ToolRegistry(),
      rules: builtinRules(ENV),
      tier: 'balanced',
      model: 'x',
      signal: controller.signal,
    },
    '说点什么',
  );

  if (afterMs > 0) await new Promise((r) => setTimeout(r, afterMs));
  controller.abort();

  const reason = await turn;
  const elapsed = Date.now() - started;
  await runtime.close();

  // 从**落库的事件**回放状态——这才是"重开会话会看到什么"
  let state = emptySessionState(sessionId);
  for await (const e of store.read(sessionId)) state = reduce(state, e);
  const persistedText = state.messages
    .flatMap((m) => (m.role === 'assistant' ? m.blocks : []))
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');

  return { types, deltas, persistedText, elapsed, reason };
}

describe('停止按钮', () => {
  it('🔴 上游彻底不再吐字时，abort 仍然能在 200ms 内让这一轮结束', async () => {
    const r = await runAndInterrupt(20);
    expect(r.reason).toBe('aborted');
    // 挂住的话这条用例会超时（5s），而不是慢一点
    expect(r.elapsed).toBeLessThan(200);
  });

  it('🔴 中断落的是两条事件：message.end 在前，message.interrupted 在后', async () => {
    const r = await runAndInterrupt(20);
    const end = r.types.indexOf('message.end');
    const interrupted = r.types.indexOf('message.interrupted');

    expect(end).toBeGreaterThanOrEqual(0);
    expect(interrupted).toBeGreaterThan(end);
    // turn.end 永远在最后：它在 finally 里
    expect(r.types.at(-1)).toBe('turn.end');
  });

  it('🔴 已经打到屏幕上的那半句话，在持久流里找得到（ADR-0008 包含性）', async () => {
    const r = await runAndInterrupt(20);
    /*
     * 只发 message.interrupted 的实现会让这条转红：deltas 里有字，
     * 而回放出来的 messages 是空的——用户看着它打出来，重开会话后它没了。
     */
    expect(r.deltas.join('')).toBe('我正在慢慢地想…');
    expect(r.persistedText).toBe(r.deltas.join(''));
  });

  it('🔴 被中断的消息在回放里是可分辨的，不长得像一条正常回复', async () => {
    const r = await runAndInterrupt(20);
    // 只发 message.end 的实现会让这条转红：回看历史时分不出哪条是被截断的
    expect(r.types).toContain('message.interrupted');
  });

  it('还没开始就 abort：照样干净收尾，不留半条消息', async () => {
    const r = await runAndInterrupt(0);
    expect(r.reason).toBe('aborted');
    expect(r.types.at(-1)).toBe('turn.end');
  });
});
