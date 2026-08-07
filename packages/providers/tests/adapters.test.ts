import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelChunk, ModelRequest } from '@xm/contracts';
import { CallId, newCallId, newMessageId } from '@xm/contracts';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import { abortLike, streamOf } from './helpers/stream.js';

/**
 * 两家适配器。
 *
 * ── 这个文件的重点是最后一组：**端口中立性** ──
 *
 * `ModelProvider` 端口写着「各家的差异全部在适配器里消化，不上浮」。只有一个实现时，
 * 这句话无法证伪：任何绑死 Anthropic 的假设都会舒服地待在端口里，直到接第二家才暴露，
 * 而那时上面已经压着 ContextBuilder、压缩与缓存断点。
 *
 * 所以最后一组用**同一个 `ModelRequest`** 喂两家，断言两边都能跑出同一串
 * 中立 chunk（modulo 各家自己的 id）。它是这条端口约定唯一的可执行形式。
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** 用固定响应喂适配器。`chunkSize` 让我们顺带验一遍分片无关性 */
function providerWith(body: string, chunkSize?: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(streamOf(body, chunkSize), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
}

const REQUEST: ModelRequest = {
  model: 'test-model',
  system: [{ text: '你是小明。', cacheable: true }],
  messages: [
    { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '读一下 /repo' }], ts: 1 },
  ],
  maxOutputTokens: 4096,
};

async function drain(it: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

/** 把随机生成的 CallId 抹平，好让两家的结果可以逐项比对 */
function normalize(chunks: readonly ModelChunk[]): unknown[] {
  const ids = new Map<string, string>();
  const idOf = (id: string): string => {
    const seen = ids.get(id);
    if (seen !== undefined) return seen;
    const next = `call#${String(ids.size)}`;
    ids.set(id, next);
    return next;
  };
  return chunks.map((c) => ('id' in c ? { ...c, id: idOf(c.id) } : c));
}

describe('Anthropic 适配器', () => {
  const run = (chunkSize?: number): Promise<ModelChunk[]> =>
    drain(
      new AnthropicProvider({
        apiKey: 'sk-test',
        fetchImpl: providerWith(fixture('anthropic-tool-use.sse'), chunkSize),
      }).stream(REQUEST, abortLike().signal),
    );

  it('思考、正文、工具调用全部解成中立 chunk', async () => {
    const kinds = (await run()).map((c) => c.kind);
    expect(kinds).toEqual([
      'thinking_delta',
      'thinking_delta',
      'thinking_signature',
      'text_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'stop',
    ]);
  });

  it('🔴 服务端的 `toolu_…` 被换成品牌化的 CallId —— 否则事件 payload 校验直接拒掉', async () => {
    const start = (await run()).find((c) => c.kind === 'tool_call_start');
    expect(start).toBeDefined();
    // 关键断言：它是 UUID，不是 toolu_ 开头的那串
    expect(() => CallId.parse(start!.id)).not.toThrow();
    expect(start!.id.startsWith('toolu_')).toBe(false);
  });

  it('🔴 usage 只发一条 —— 服务端分两处给，发两条就把一次请求记成两次', async () => {
    const usages = (await run()).filter((c) => c.kind === 'usage');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({
      kind: 'usage',
      usage: {
        inputTokens: 1024,
        outputTokens: 57, // message_delta 里的值覆盖 message_start 的占位 1
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
      },
    });
  });

  it('增量 JSON 原样透传，拼起来才是完整入参', async () => {
    const args = (await run())
      .filter((c) => c.kind === 'tool_call_delta')
      .map((c) => c.argsJson)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: '/repo' });
  });

  it('逐字节分片解出的结果与一次性读完完全一致', async () => {
    expect(normalize(await run(1))).toEqual(normalize(await run()));
  });

  it('cacheable 的 system 段翻成 cache_control，thinking 开启时不传 temperature', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    await drain(
      new AnthropicProvider({ apiKey: 'k', fetchImpl }).stream(
        { ...REQUEST, temperature: 0.3, thinking: { enabled: true, budgetTokens: 1024 } },
        abortLike().signal,
      ),
    );

    expect(sent.system).toEqual([
      { type: 'text', text: '你是小明。', cache_control: { type: 'ephemeral' } },
    ]);
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    // 开思考时服务端要求 temperature 必须是 1，所以这里必须整个不传
    expect('temperature' in sent).toBe(false);
  });

  it('🔴 多模态失败关闭，不悄悄换成一句文字', async () => {
    const withImage: ModelRequest = {
      ...REQUEST,
      messages: [
        {
          id: newMessageId(),
          role: 'user',
          blocks: [
            { type: 'image', source: { hash: 'a'.repeat(64), mime: 'image/png', size: 10 } },
          ],
          ts: 1,
        },
      ],
    };
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: providerWith('') });
    await expect(drain(provider.stream(withImage, abortLike().signal))).rejects.toThrow(/多模态/);
  });
});

describe('OpenAI 兼容适配器', () => {
  const run = (chunkSize?: number): Promise<ModelChunk[]> =>
    drain(
      new OpenAICompatibleProvider({
        apiKey: 'sk-test',
        fetchImpl: providerWith(fixture('openai-tool-use.sse'), chunkSize),
      }).stream(REQUEST, abortLike().signal),
    );

  it('reasoning_content 归一成 thinking_delta', async () => {
    const thinking = (await run()).filter((c) => c.kind === 'thinking_delta');
    expect(thinking.map((c) => c.text).join('')).toBe('用户想读一个目录，先调 fs.list。');
  });

  it('`data: [DONE]` 收尾不会被当成 JSON', async () => {
    const chunks = await run();
    expect(chunks.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });

  it('🔴 缓存命中的 token 从 prompt_tokens 里减掉 —— 否则两家的输入量不可比、成本算重', async () => {
    const usage = (await run()).find((c) => c.kind === 'usage');
    expect(usage).toEqual({
      kind: 'usage',
      // 1824 - 800，与 Anthropic 那边分开报的 1024 对上
      usage: { inputTokens: 1024, outputTokens: 57, cacheReadTokens: 800, cacheWriteTokens: 0 },
    });
  });

  it('🔴 工具结果从 user 消息里拆成独立的 tool 消息', async () => {
    let sent: { messages?: { role: string }[] } = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as { messages?: { role: string }[] };
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    const callId = newCallId();
    await drain(
      new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
        {
          ...REQUEST,
          messages: [
            {
              id: newMessageId(),
              role: 'assistant',
              blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } }],
              ts: 1,
            },
            {
              id: newMessageId(),
              role: 'user',
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: callId,
                  content: [{ type: 'text', text: 'a.ts\nb.ts' }],
                  isError: false,
                },
              ],
              ts: 2,
            },
          ],
        },
        abortLike().signal,
      ),
    );

    // system + assistant(tool_calls) + tool —— 那条 user 消息整个变成了 role: 'tool'
    expect(sent.messages?.map((m) => m.role)).toEqual(['system', 'assistant', 'tool']);
  });

  it('逐字节分片解出的结果与一次性读完完全一致', async () => {
    expect(normalize(await run(1))).toEqual(normalize(await run()));
  });

  it(
    '🔴 历史 assistant 消息里的 thinking 块要挂回 reasoning_content —— ' +
      'DeepSeek 思考模式下，带过 tool_calls 的这一轮不把它带回去会被 400 拒',
    async () => {
      let sent: { messages?: { role: string; reasoning_content?: string }[] } = {};
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        sent = JSON.parse(init?.body as string) as typeof sent;
        return Promise.resolve(new Response(streamOf(''), { status: 200 }));
      }) as unknown as typeof fetch;

      const callId = newCallId();
      await drain(
        new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
          {
            ...REQUEST,
            messages: [
              {
                id: newMessageId(),
                role: 'assistant',
                blocks: [
                  { type: 'thinking', text: '用户想读一个目录，先调 fs.list。' },
                  { type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } },
                ],
                ts: 1,
              },
              {
                id: newMessageId(),
                role: 'user',
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId: callId,
                    content: [{ type: 'text', text: 'a.ts\nb.ts' }],
                    isError: false,
                  },
                ],
                ts: 2,
              },
            ],
          },
          abortLike().signal,
        ),
      );

      const assistantMsg = sent.messages?.find((m) => m.role === 'assistant');
      expect(assistantMsg?.reasoning_content).toBe('用户想读一个目录，先调 fs.list。');
    },
  );

  it('没有思考块的历史消息不会凭空长出 reasoning_content 字段', async () => {
    let sent: { messages?: Record<string, unknown>[] } = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as typeof sent;
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    await drain(
      new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(REQUEST, abortLike().signal),
    );

    const userMsg = sent.messages?.find((m) => m.role === 'user');
    expect(userMsg).not.toHaveProperty('reasoning_content');
  });
});

describe('端口中立性：同一个 ModelRequest 喂两家', () => {
  it('🔴 两家解出的中立 chunk 序列一致（modulo 各家的 id）', async () => {
    const a = normalize(
      await drain(
        new AnthropicProvider({
          apiKey: 'k',
          fetchImpl: providerWith(fixture('anthropic-tool-use.sse')),
        }).stream(REQUEST, abortLike().signal),
      ),
    );
    const b = normalize(
      await drain(
        new OpenAICompatibleProvider({
          apiKey: 'k',
          fetchImpl: providerWith(fixture('openai-tool-use.sse')),
        }).stream(REQUEST, abortLike().signal),
      ),
    );

    /*
     * 两份 fixture 是"同一段模型输出的两种 wire format"。合法差异恰好两处，
     * 而**两处都是各家真实存在的能力差异，不是我们的实现漏了什么**：
     *
     *   · `thinking_signature` —— 思考签名是 Anthropic 独有的机制，
     *     OpenAI 那边没有对应的东西可回传（`ModelCapabilities.thinking` 正是为此存在）
     *   · `cacheWriteTokens` —— OpenAI 兼容接口不单独计量"写入缓存"，只报命中数
     *
     * 除这两处之外一律要求逐字段相同。差异清单短且每条都说得出理由，
     * 这条端口才算真的中立；清单一长，就说明差异开始往上浮了。
     */
    const stripCacheWrite = (chunks: readonly unknown[]): unknown[] =>
      chunks.map((c) => {
        const chunk = c as { kind: string; usage?: Record<string, number> };
        if (chunk.kind !== 'usage' || chunk.usage === undefined) return c;
        const rest = { ...chunk.usage };
        delete rest.cacheWriteTokens;
        return { ...chunk, usage: rest };
      });

    expect(stripCacheWrite(b)).toEqual(
      stripCacheWrite(a.filter((c) => (c as { kind: string }).kind !== 'thinking_signature')),
    );
  });

  it('两家都不把自己的 wire 字段漏进中立结构', async () => {
    const chunks = await drain(
      new AnthropicProvider({
        apiKey: 'k',
        fetchImpl: providerWith(fixture('anthropic-tool-use.sse')),
      }).stream(REQUEST, abortLike().signal),
    );
    const keys = new Set(chunks.flatMap((c) => Object.keys(c)));
    expect([...keys].sort()).toEqual(['argsJson', 'id', 'kind', 'name', 'reason', 'signature', 'text', 'usage']);
  });
});
