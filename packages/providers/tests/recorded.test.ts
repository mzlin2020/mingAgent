import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelChunk, ModelRequest } from '@xm/contracts';
import { CallId, newMessageId } from '@xm/contracts';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import { abortLike, streamOf } from './helpers/stream.js';

/**
 * 回放**真实录制**的 SSE 字节。
 *
 * ── 这个文件和 `adapters.test.ts` 的区别是它唯一的价值 ──
 *
 * `adapters.test.ts` 喂的 fixture 是照着文档手写的：我们先想好服务端"应该"发什么，
 * 再写代码解析它——于是那组用例证明的其实是「代码和我们的想象一致」。
 * ADR-0017（trustLevel 硬编码）与 ADR-0018（8.3 短名）都是这个形状栽的：
 * **测试全绿，真实输入下从未跑过。**
 *
 * 这里的 `live-*.sse` 是 2026-08-06 从真实服务端（DeepSeek 的 Anthropic 兼容端点与
 * OpenAI 兼容端点）原样抓下来的字节，一个字符没改。CI 不需要 key 也能回放它们。
 *
 * 录制发现的、手写 fixture 里**一处都没有**的东西，见下面每组的注释。
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** 分片大小刻意取素数：真实网络的分片边界不会正好落在帧边界上 */
function replay(body: string, chunkSize = 97): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(streamOf(body, chunkSize), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
}

const ASK: ModelRequest = {
  model: 'deepseek-v4-flash',
  system: [{ text: '你是一个测试助手。', cacheable: true }],
  messages: [
    { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '只回复两个字：收到' }], ts: 1 },
  ],
  maxOutputTokens: 64,
};

async function drain(it: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const textOf = (chunks: readonly ModelChunk[]): string =>
  chunks.map((c) => (c.kind === 'text_delta' ? c.text : '')).join('');

const thinkingOf = (chunks: readonly ModelChunk[]): string =>
  chunks.map((c) => (c.kind === 'thinking_delta' ? c.text : '')).join('');

const argsOf = (chunks: readonly ModelChunk[]): string =>
  chunks.map((c) => (c.kind === 'tool_call_delta' ? c.argsJson : '')).join('');

const usageOf = (chunks: readonly ModelChunk[]): ModelChunk[] =>
  chunks.filter((c) => c.kind === 'usage');

describe('回放真实录制 · Anthropic 兼容端点', () => {
  it('解出文本，且 usage / stop 各恰好一条', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'not-used-in-replay',
      fetchImpl: replay(fixture('live-deepseek-anthropic-text.sse')),
    });
    const chunks = await drain(provider.stream(ASK, abortLike().signal));

    expect(textOf(chunks)).toBe('收到');
    expect(usageOf(chunks)).toHaveLength(1);
    expect(usageOf(chunks)[0]).toEqual({
      kind: 'usage',
      usage: { inputTokens: 93, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // stop 必须是最后一条：Turn 循环靠它收尾
    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  /**
   * **录制才发现的**：请求里根本没有 `thinking` 字段，服务端照样发 thinking 块。
   *
   * 我们手写的 fixture 里没有这一段——因为按 Anthropic 的文档，不开就不该有。
   * 于是「能力表说这个模型 thinking: false」和「流里真的有 thinking_delta」
   * 是可以同时成立的，`catalog.ts` 的能力值不能被当成"流里不会出现什么"的保证。
   */
  it('未请求 thinking 时服务端仍可能发思考块，照常解出而不是报错', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'not-used-in-replay',
      fetchImpl: replay(fixture('live-deepseek-anthropic-text.sse')),
    });
    const chunks = await drain(provider.stream(ASK, abortLike().signal));

    expect(thinkingOf(chunks).length).toBeGreaterThan(0);
    expect(chunks.filter((c) => c.kind === 'thinking_signature')).toHaveLength(1);
  });

  /**
   * **录制才发现的**：这一家在 Anthropic 端点上给的 tool id 是 `call_00_…`，
   * 不是文档里的 `toolu_…`。两种都不是 UUID——「一律重映射成 CallId」这条
   * 因此不是对某一家 id 前缀的适配，而是对"服务端 id 格式不受我们控制"的适配。
   */
  it('工具调用：服务端 id 被换成合法 CallId，增量 JSON 拼得回原样', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'not-used-in-replay',
      fetchImpl: replay(fixture('live-deepseek-anthropic-tool.sse')),
    });
    const chunks = await drain(provider.stream(ASK, abortLike().signal));

    const start = chunks.find((c) => c.kind === 'tool_call_start');
    expect(start).toMatchObject({ kind: 'tool_call_start', name: 'get_weather' });
    // 录到的原始 id 是 `call_00_u3DHv7gNhvAqKvozebVA2670`，直接用会被事件校验拒掉
    expect(() => CallId.parse(start?.kind === 'tool_call_start' ? start.id : '')).not.toThrow();

    expect(JSON.parse(argsOf(chunks))).toEqual({ city: '北京' });
    expect(chunks.filter((c) => c.kind === 'tool_call_end')).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });
});

describe('回放真实录制 · OpenAI 兼容端点', () => {
  const openai = (name: string): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({
      apiKey: 'not-used-in-replay',
      baseUrl: 'https://example.invalid/v1',
      id: 'deepseek',
      fetchImpl: replay(fixture(name)),
    });

  it('把 reasoning_content 解成 thinking_delta，usage / stop 各恰好一条', async () => {
    const chunks = await drain(
      openai('live-deepseek-openai-text.sse').stream(ASK, abortLike().signal),
    );

    expect(textOf(chunks)).toBe('收到');
    expect(thinkingOf(chunks).length).toBeGreaterThan(0);
    expect(usageOf(chunks)).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  /**
   * **这一条是录制带来的最硬的证据。**
   *
   * 我们减掉缓存命中的 token（`prompt_tokens - cached_tokens`），此前只有一条
   * 自己编的用例证明。真实响应里服务端**自己也算了一遍**并放在
   * `prompt_cache_miss_tokens` 里：359 - 256 = 103，与我们的减法逐位相同。
   *
   * 也就是说这条断言不再是"我们认为应该这样减"，而是"服务端确认就是这样减的"。
   */
  it('缓存命中的 token 从输入里减掉，结果与服务端自报的 miss 数一致', async () => {
    const chunks = await drain(
      openai('live-deepseek-openai-tool.sse').stream(ASK, abortLike().signal),
    );

    expect(usageOf(chunks)[0]).toEqual({
      kind: 'usage',
      usage: {
        // 录制中：prompt_tokens 359，cached_tokens 256，prompt_cache_miss_tokens 103
        inputTokens: 103,
        outputTokens: 68,
        cacheReadTokens: 256,
        // 这一家不单独计缓存写入。差异合法，且只能停在这里——见 adapters.test.ts 的中立性组
        cacheWriteTokens: 0,
      },
    });
    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
    expect(JSON.parse(argsOf(chunks))).toEqual({ city: '北京' });
  });
});

/**
 * 同一段真实录制，换二十种分片边界都必须解出同一串 chunk。
 *
 * 真实网络的 TCP 分片会把一个 UTF-8 汉字劈成两半、把 `data:` 和它的 JSON 劈开、
 * 把帧尾的空行劈成 `\n` + `\n`。录制回放如果只用一种分片，测的是运气。
 */
describe('分片无关性（拿真实字节验）', () => {
  it('任意分片边界下解码结果一致', async () => {
    const body = fixture('live-deepseek-anthropic-text.sse');
    const baseline = await drain(
      new AnthropicProvider({ apiKey: 'x', fetchImpl: replay(body, 1 << 20) }).stream(
        ASK,
        abortLike().signal,
      ),
    );

    for (const size of [1, 2, 3, 7, 13, 64, 997]) {
      const chunks = await drain(
        new AnthropicProvider({ apiKey: 'x', fetchImpl: replay(body, size) }).stream(
          ASK,
          abortLike().signal,
        ),
      );
      expect(chunks, `分片 ${String(size)} 字节`).toEqual(baseline);
    }
  });
});
