import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message, ModelChunk, ModelRequest } from '@xm/contracts';
import { CallId, newCallId, newMessageId } from '@xm/contracts';
import { MemoryBlobStore } from '@xm/kernel';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import { abortLike, streamOf } from './helpers/stream.js';

/** 测试专用 sha256——这个包本身不依赖 node:crypto，但测试文件不受那条 depcruise 规则约束 */
const sha256Hex = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

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

  it('🔴 document 仍然失败关闭，不悄悄换成一句文字 —— image 已支持，document 还没', async () => {
    const withDocument: ModelRequest = {
      ...REQUEST,
      messages: [
        {
          id: newMessageId(),
          role: 'user',
          blocks: [
            { type: 'document', source: { hash: 'a'.repeat(64), mime: 'application/pdf', size: 10 } },
          ],
          ts: 1,
        },
      ],
    };
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl: providerWith('') });
    await expect(drain(provider.stream(withDocument, abortLike().signal))).rejects.toThrow(/多模态/);
  });

  it('图片块编成 base64 塞进 source —— 判权用的 BlobRef 与发给模型的字节是同一份', async () => {
    const blobs = new MemoryBlobStore(sha256Hex);
    const bytes = new TextEncoder().encode('假装是一张图片');
    const ref = await blobs.put(bytes, 'image/png', 'demo.png');

    let sent: { messages?: { content?: unknown }[] } = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as typeof sent;
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    const withImage: ModelRequest = {
      ...REQUEST,
      messages: [
        { id: newMessageId(), role: 'user', blocks: [{ type: 'image', source: ref }], ts: 1 },
      ],
    };

    await drain(
      new AnthropicProvider({ apiKey: 'k', fetchImpl, blobs }).stream(withImage, abortLike().signal),
    );

    const expectedData = Buffer.from(bytes).toString('base64');
    expect(sent.messages?.[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: expectedData } },
    ]);
  });

  it('🔴 图片块存在但没配 blobs —— 装配错误，报内部错误，不是悄悄发个空图', async () => {
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
    await expect(drain(provider.stream(withImage, abortLike().signal))).rejects.toThrow(/内部错误/);
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

  // 注意断言的主语是 **user 消息**：它任何时候都不该长出这个字段。
  // 别把它读成"assistant 也不该长"——带过 tool_calls 的 assistant 恰恰相反，见下一组。
  it('没有思考块的历史 user 消息不会凭空长出 reasoning_content 字段', async () => {
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

  /**
   * ── reasoning_content 的回传闸门 ──
   *
   * 上面那条 🔴 用例锁的是"有思考文本要带回去"，它漏了紧挨着的另一半：模型这一轮
   * **没吐思考、只吐了 tool_calls**。真实会话在这里 400，且一发不可收拾——脏历史留在
   * 会话里，之后每发一条消息都会重新拼出同样缺字段的请求。
   *
   * 真调用问出来的契约（`live.test.ts` 里那条用例锁着实网行为）：
   * 不带字段 → 400，`null` → 400，`""` → 200。
   */
  describe('带过 tool_calls 的 assistant 消息', () => {
    /** 抓一次出站请求体——这一组要连写三条正反用例，再内联三份同样的 fetchImpl 就该抽了 */
    function capture(): {
      body: () => { messages?: Record<string, unknown>[] };
      fetchImpl: typeof fetch;
    } {
      let sent: { messages?: Record<string, unknown>[] } = {};
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        sent = JSON.parse(init?.body as string) as typeof sent;
        return Promise.resolve(new Response(streamOf(''), { status: 200 }));
      }) as unknown as typeof fetch;
      return { body: () => sent, fetchImpl };
    }

    /** 出事的那个形状：assistant 只有 tool_use，没有 thinking 块 */
    function historyWithoutThinking(lead: readonly ContentBlock[] = []): Message[] {
      const callId = newCallId();
      return [
        ...(lead.length === 0
          ? []
          : [{ id: newMessageId(), role: 'assistant' as const, blocks: [...lead], ts: 0 }]),
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
      ];
    }

    const send = async (model: string, messages: Message[]): Promise<Record<string, unknown>[]> => {
      const { body, fetchImpl } = capture();
      await drain(
        new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
          { ...REQUEST, model, messages },
          abortLike().signal,
        ),
      );
      return (body().messages ?? []).filter((m) => m.role === 'assistant');
    };

    it('🔴 思考模型：没有 thinking 也要带 reasoning_content —— 缺字段会被 400 拒', async () => {
      const [assistant] = await send('deepseek-v4-flash', historyWithoutThinking());

      expect(assistant).toHaveProperty('tool_calls');
      // 必须是空串。`null` 和"没有这个字段"一样会被 400 拒——
      // 照抄官方示例回传 `message.reasoning_content` 正好会踩这里（无思考轮它是 None）
      expect(assistant?.reasoning_content).toBe('');
    });

    it('不思考的兼容端不会白收一个陌生字段', async () => {
      const [assistant] = await send('test-model', historyWithoutThinking());

      expect(assistant).toHaveProperty('tool_calls');
      expect(assistant).not.toHaveProperty('reasoning_content');
    });

    /*
     * 能力表永远追不上新模型。所以闸门还认第二个证据：这段历史里真出现过 thinking 块，
     * 就说明对面认这个字段——哪怕它的名字不在 `catalog.ts` 里。
     * 出事的那个会话正是这个形状：第一轮有思考，后面某一轮没有。
     */
    it('能力表不认、但历史里真吐过思考的模型，同样补上字段', async () => {
      const messages = historyWithoutThinking([{ type: 'thinking', text: '先看看目录里有什么。' }]);
      const [thinker, silent] = await send('some-new-reasoner', messages);

      expect(thinker?.reasoning_content).toBe('先看看目录里有什么。');
      expect(silent?.reasoning_content).toBe('');
    });
  });

  /**
   * ── 空正文怎么写：`null` 还是 `""` ──
   *
   * 真实报错原文：`Invalid assistant message: content or tool_calls must be set`。
   * 触发路径不是构造出来的：模型思考到把 `max_tokens` 用光、一个字的正文都没说完
   * （`turn.end reason=max_tokens`），落库的 assistant 消息**只有 thinking 块**。
   * 出站编码把它写成 `{ content: null, reasoning_content: "…" }` 且没有 `tool_calls`
   * ——两个必备项一个都没给。脏历史留在会话里，之后每发一条都 400，会话彻底作废。
   *
   * 与上面那组是同一个教训的第二次出现：**空的表示要挑对**。
   */
  describe('空正文的 assistant 消息', () => {
    const sendBody = async (
      req: Partial<ModelRequest>,
    ): Promise<{ messages: Record<string, unknown>[]; body: Record<string, unknown> }> => {
      let sent: Record<string, unknown> = {};
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        sent = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Promise.resolve(new Response(streamOf(''), { status: 200 }));
      }) as unknown as typeof fetch;

      await drain(
        new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
          { ...REQUEST, ...req },
          abortLike().signal,
        ),
      );
      return { messages: (sent.messages ?? []) as Record<string, unknown>[], body: sent };
    };

    /** 思考烧完 max_tokens 那一轮落下来的形状：assistant 只剩一个 thinking 块 */
    const thinkingOnlyHistory: Message[] = [
      { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '帮我算一下' }], ts: 0 },
      {
        id: newMessageId(),
        role: 'assistant',
        blocks: [{ type: 'thinking', text: '让我想想……（一直想到 max_tokens 用光）' }],
        ts: 1,
      },
      { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '所以结果是什么' }], ts: 2 },
    ];

    it('🔴 只有 thinking 的历史：content 必须是空串 —— `null` 且无 tool_calls 会被 400 拒', async () => {
      const { messages } = await sendBody({ model: 'deepseek-v4-flash', messages: thinkingOnlyHistory });
      const assistant = messages.find((m) => m.role === 'assistant');

      expect(assistant, '这条消息本身要留在历史里（思考也是发生过的事实）').toBeDefined();
      expect(assistant).not.toHaveProperty('tool_calls');
      expect(assistant?.content, 'content 或 tool_calls 必须有一个 —— null 等于两个都没给').toBe('');
      expect(assistant?.reasoning_content, '思考仍要回传').not.toBe('');
    });

    /**
     * 另一半不能跟着改：有 `tool_calls` 时 `null` 是 OpenAI 的规范形状，
     * 而且 `live.test.ts` 的对照组已经用真实服务端证过它收。
     */
    it('有 tool_calls 的空正文仍然是 null —— 那是有据可查的那一档', async () => {
      const callId = newCallId();
      const { messages } = await sendBody({
        model: 'deepseek-v4-flash',
        messages: [
          { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '读一下 /repo' }], ts: 0 },
          {
            id: newMessageId(),
            role: 'assistant',
            blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } }],
            ts: 1,
          },
        ],
      });
      const assistant = messages.find((m) => m.role === 'assistant');

      expect(assistant).toHaveProperty('tool_calls');
      expect(assistant?.content).toBeNull();
    });
  });

  /**
   * ── 关思考 ──
   *
   * 会思考的模型默认开着，推理文本同样吃 `max_tokens`。对一次只要 24 个字的调用
   * （ADR-0038 的会话自动命名）那意味着预算被推理吃光、正文空着回来，标题静默不改。
   * 所以中立层的 `thinking.enabled === false` 必须真的翻译成一个出站参数。
   */
  describe('thinking.enabled === false 的出站翻译', () => {
    const bodyOf = async (req: Partial<ModelRequest>): Promise<Record<string, unknown>> => {
      let sent: Record<string, unknown> = {};
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        sent = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Promise.resolve(new Response(streamOf(''), { status: 200 }));
      }) as unknown as typeof fetch;

      await drain(
        new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
          { ...REQUEST, ...req },
          abortLike().signal,
        ),
      );
      return sent;
    };

    it('🔴 思考模型：关思考要发出去 —— 省略字段等于交给服务端默认（它默认开着）', async () => {
      const body = await bodyOf({ model: 'deepseek-v4-flash', thinking: { enabled: false } });
      expect(body.thinking).toEqual({ type: 'disabled' });
    });

    it('不思考的兼容端一个陌生字段都不多收 —— 多发一个能让整条请求 400', async () => {
      const body = await bodyOf({ model: 'test-model', thinking: { enabled: false } });
      expect(body).not.toHaveProperty('thinking');
    });

    it('不提 thinking 的调用方（回合主循环）行为不变', async () => {
      const body = await bodyOf({ model: 'deepseek-v4-flash' });
      expect(body).not.toHaveProperty('thinking');
    });

    it('enabled: true 这一侧刻意不接 —— 开思考是一整条链路，不在这里开半条', async () => {
      const body = await bodyOf({ model: 'deepseek-v4-flash', thinking: { enabled: true } });
      expect(body).not.toHaveProperty('thinking');
    });
  });

  it('图片块存在时 content 从字符串换成数组 —— 两种形状不能混用', async () => {
    const blobs = new MemoryBlobStore(sha256Hex);
    const bytes = new TextEncoder().encode('假装是一张图片');
    const ref = await blobs.put(bytes, 'image/png', 'demo.png');

    let sent: { messages?: { role: string; content?: unknown }[] } = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as typeof sent;
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    const withImage: ModelRequest = {
      ...REQUEST,
      messages: [
        {
          id: newMessageId(),
          role: 'user',
          blocks: [
            { type: 'text', text: '这张图是什么' },
            { type: 'image', source: ref },
          ],
          ts: 1,
        },
      ],
    };

    await drain(
      new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl, blobs }).stream(
        withImage,
        abortLike().signal,
      ),
    );

    const expectedData = Buffer.from(bytes).toString('base64');
    const userMsg = sent.messages?.find((m) => m.role === 'user');
    expect(userMsg?.content).toEqual([
      { type: 'text', text: '这张图是什么' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${expectedData}` } },
    ]);
  });

  it('没有图片的普通消息 content 仍然是字符串 —— 不因为支持了图片就改变现有 wire 形状', async () => {
    let sent: { messages?: { role: string; content?: unknown }[] } = {};
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string) as typeof sent;
      return Promise.resolve(new Response(streamOf(''), { status: 200 }));
    }) as unknown as typeof fetch;

    await drain(
      new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(REQUEST, abortLike().signal),
    );

    const userMsg = sent.messages?.find((m) => m.role === 'user');
    expect(typeof userMsg?.content).toBe('string');
  });

  it('🔴 图片块存在但没配 blobs —— 装配错误，报内部错误', async () => {
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
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl: providerWith('') });
    await expect(drain(provider.stream(withImage, abortLike().signal))).rejects.toThrow(/内部错误/);
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
