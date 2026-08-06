import { describe, expect, it } from 'vitest';
import type { ModelChunk, ModelRequest } from '@xm/contracts';
import { newMessageId } from '@xm/contracts';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import type { AbortSignalLike } from './helpers/stream.js';
import { abortLike, abortableStream } from './helpers/stream.js';

/**
 * 端口约定：**取消时正常结束迭代，不抛。**
 *
 * ── 这条约定是被一次真调用逼出来的 ──
 *
 * `ModelProvider` 端口此前对"取消时迭代器怎么结束"**只字未提**。真实 `fetch` 在
 * abort 时让正文读取抛 `AbortError`，于是每个调用方都得自己分辨"这是用户取消
 * 还是真出错"——而第一个调用方（`turn.ts`）就分辨错了：中断被记成 `error.raised`，
 * 用户点停止收到一条红色报错。
 *
 * 单元测试没抓到，因为造出来的流永远配合我们停下，而断言只覆盖了"该发生的发生了"。
 *
 * 现在约定写进端口，这个文件是它的可执行形式。
 */

const REQUEST: ModelRequest = {
  model: 'test-model',
  system: [],
  messages: [{ id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '写点长的' }], ts: 1 }],
  maxOutputTokens: 1024,
};

/** 先吐 `prefix`，然后挂住；signal 一 abort 就让正文读取当场抛——真 undici 的形状 */
function abortingFetch(ab: { signal: AbortSignalLike }, prefix: string): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const inner = init?.signal;
    const bridged: AbortSignalLike = {
      addEventListener: (_t, l) => inner?.addEventListener('abort', l),
      removeEventListener: (_t, l) => inner?.removeEventListener('abort', l),
      get aborted() {
        return inner?.aborted ?? false;
      },
    };
    return Promise.resolve(
      new Response(abortableStream(bridged, prefix), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  }) as unknown as typeof fetch;
}

/** 边收边在第 n 条 chunk 处 abort，返回收到的全部 chunk（不吞异常） */
async function drainAndAbort(
  stream: AsyncIterable<ModelChunk>,
  abort: () => void,
  after = 1,
): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of stream) {
    out.push(c);
    if (out.length === after) abort();
  }
  return out;
}

const ANTHROPIC_PREFIX =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半句"}}\n\n';

const OPENAI_PREFIX =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}\n\n';

describe('取消时的端口约定', () => {
  it('🔴 Anthropic：取消不抛，以 stop(aborted) 收尾', async () => {
    const ab = abortLike();
    const provider = new AnthropicProvider({
      apiKey: 'x',
      fetchImpl: abortingFetch(ab, ANTHROPIC_PREFIX),
    });

    // 不包 try/catch 是**故意的**：抛出去这条用例就该失败
    const chunks = await drainAndAbort(provider.stream(REQUEST, ab.signal), ab.abort);

    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'aborted' });
    expect(chunks.filter((c) => c.kind === 'stop')).toHaveLength(1);
  });

  it('🔴 OpenAI 兼容：取消不抛，以 stop(aborted) 收尾', async () => {
    const ab = abortLike();
    const provider = new OpenAICompatibleProvider({
      apiKey: 'x',
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: abortingFetch(ab, OPENAI_PREFIX),
    });

    const chunks = await drainAndAbort(provider.stream(REQUEST, ab.signal), ab.abort);

    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'aborted' });
  });

  /**
   * 🔴 中断时**不发 usage**。
   *
   * 服务端只给了输入侧（`message_start` 里的 input_tokens），最终用量从没到过。
   * 顺手把手里这半份发出去，`usage.recorded` 就会落一条 `outputTokens: 0`——
   * 把"不知道生成了多少"写成"生成了零个"。与 `costOf()` 算不出时返回 `undefined`
   * 而不是 0 是同一条纪律。
   */
  it('🔴 中断时不发 usage —— 半份用量比没有用量更坏', async () => {
    const ab = abortLike();
    const provider = new AnthropicProvider({
      apiKey: 'x',
      fetchImpl: abortingFetch(ab, ANTHROPIC_PREFIX),
    });

    const chunks = await drainAndAbort(provider.stream(REQUEST, ab.signal), ab.abort);

    expect(chunks.filter((c) => c.kind === 'usage')).toHaveLength(0);
  });

  /**
   * 🔴 中断时**不补 `tool_call_end`**。
   *
   * 参数 JSON 是一个字符一个字符来的（真实录制里看得很清楚）。被截断时手里是
   * `{"ci` 这种半截串，补一条 end 等于告诉上层"这个调用完整了"，
   * 而 `turn.ts` 的 `parseArgs` 会拿它去 `JSON.parse`。
   */
  it('🔴 中断时不给残缺的工具调用补 tool_call_end', async () => {
    const ab = abortLike();
    const provider = new OpenAICompatibleProvider({
      apiKey: 'x',
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: abortingFetch(ab, OPENAI_PREFIX),
    });

    // 第一条是 tool_call_start，收到就停——此刻参数只到 `{"ci`
    const chunks = await drainAndAbort(provider.stream(REQUEST, ab.signal), ab.abort);

    expect(chunks.some((c) => c.kind === 'tool_call_start')).toBe(true);
    expect(chunks.filter((c) => c.kind === 'tool_call_end')).toHaveLength(0);
  });

  /**
   * 反过来的一半：**不是取消造成的异常照常往外抛。**
   *
   * 把"取消时不抛"写成"永远不抛"，等于把真实故障（连接断了、上游 500 到一半）
   * 伪装成一次正常的结束——用户会看到回复戛然而止却没有任何错误提示。
   */
  it('连接真出错（没人取消过）时照常抛，不伪装成正常结束', async () => {
    const ab = abortLike();
    /*
     * 先让消费者**真的读到**前缀，再让连接断。
     *
     * 第一版写成 `start()` 里 enqueue 完立刻 error——那样 `controller.error()`
     * 会把队列一起丢掉，消费者一个 chunk 都拿不到。测出来的是一个不存在的形状：
     * 真实的 socket 断开总是发生在若干字节已经交付之后。
     */
    let pulls = 0;
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(new TextEncoder().encode(ANTHROPIC_PREFIX));
              else controller.error(new Error('socket hang up'));
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const provider = new AnthropicProvider({ apiKey: 'x', fetchImpl });
    const chunks: ModelChunk[] = [];

    await expect(
      (async () => {
        for await (const c of provider.stream(REQUEST, ab.signal)) chunks.push(c);
      })(),
    ).rejects.toThrow('socket hang up');

    // 已经到手的部分照样交出去了——Turn 循环靠它落 message.end（ADR-0008 包含性）
    expect(chunks.some((c) => c.kind === 'text_delta')).toBe(true);
  });
});
