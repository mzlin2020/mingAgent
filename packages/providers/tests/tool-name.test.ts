import { describe, expect, it } from 'vitest';
import type { ModelChunk, ModelRequest, ToolDescriptor } from '@xm/contracts';
import { DEFAULT_RESULT_LIMITS, newCallId, newMessageId } from '@xm/contracts';
import { AnthropicProvider, OpenAICompatibleProvider, buildToolNameCodec } from '@xm/providers';
import { abortLike, streamOf } from './helpers/stream.js';

/**
 * ── 工具名的 wire 编解码 ──
 *
 * DeepSeek（OpenAI 兼容）用真实请求照出：`tools[].function.name` 必须匹配
 * `^[a-zA-Z0-9_-]+$`，而 `ToolDescriptor.name` 的契约要求恰恰相反——
 * 至少一个点号（`descriptor.ts`：`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/`）。
 * 也就是说**每一个合法工具名都会被两家服务端拒绝**，这不是边界情况。
 *
 * 两组用例：`buildToolNameCodec` 的纯函数行为，以及两家适配器在真实请求/响应
 * 形状下的编码（发出去）与解码（收回来）。
 */

describe('buildToolNameCodec：纯函数行为', () => {
  it('点号换成下划线', () => {
    const codec = buildToolNameCodec(['fs.read', 'shell.exec']);
    expect(codec.encode('fs.read')).toBe('fs_read');
    expect(codec.encode('shell.exec')).toBe('shell_exec');
  });

  it('解码是编码的严格逆运算', () => {
    const codec = buildToolNameCodec(['fs.read', 'fs.write', 'fs.list']);
    for (const name of ['fs.read', 'fs.write', 'fs.list']) {
      expect(codec.decode(codec.encode(name))).toBe(name);
    }
  });

  it('本来就合法的名字原样通过', () => {
    const codec = buildToolNameCodec(['already_safe']);
    expect(codec.encode('already_safe')).toBe('already_safe');
  });

  it('🔴 两个不同的原名清洗后撞车，各自解回各自的原名而不是互相覆盖', () => {
    // "a.b" 与 "a_b" 清洗/本身都是 "a_b"——如果只做替换不做去重，
    // 后写入的会覆盖前一个，解码时两个原名会被路由到同一个工具
    const codec = buildToolNameCodec(['a.b', 'a_b']);
    const wireA = codec.encode('a.b');
    const wireB = codec.encode('a_b');
    expect(wireA).not.toBe(wireB);
    expect(codec.decode(wireA)).toBe('a.b');
    expect(codec.decode(wireB)).toBe('a_b');
  });

  it('同一个原名出现两次不报错，编码结果一致', () => {
    const codec = buildToolNameCodec(['fs.read', 'fs.read']);
    expect(codec.encode('fs.read')).toBe('fs_read');
  });

  it('解码一个从没申报过的 wire 名：原样返回，不抛错', () => {
    const codec = buildToolNameCodec(['fs.read']);
    expect(codec.decode('never_declared')).toBe('never_declared');
  });
});

// ── 集成：两家适配器的编码（发出去）与解码（收回来）──────────────

const FS_READ_TOOL: ToolDescriptor = {
  name: 'fs.read',
  group: 'fs',
  description: '按行读取文件',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  risk: 'safe',
  capabilities: ['fs.read'],
  concurrency: 'parallel',
  resultLimits: DEFAULT_RESULT_LIMITS,
  source: { kind: 'builtin' },
};

const REQUEST_WITH_TOOL: ModelRequest = {
  model: 'test-model',
  system: [],
  messages: [
    { id: newMessageId(), role: 'user', blocks: [{ type: 'text', text: '读一下 /repo' }], ts: 1 },
  ],
  maxOutputTokens: 4096,
  tools: [FS_READ_TOOL],
  toolChoice: { name: 'fs.read' },
};

async function drain(it: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function capture(): { fetchImpl: typeof fetch; sent: () => Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Promise.resolve(new Response(streamOf(''), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent: () => body };
}

const ANTHROPIC_TOOL_CALL_SSE = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read","input":{}}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
  '',
].join('\n');

const OPENAI_TOOL_CALL_SSE = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"fs_read","arguments":"{}"}}]},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('🔴 Anthropic：工具名过 wire 一来一回', () => {
  it('发出去时点号换成下划线——tools[]、tool_choice、历史 tool_use 三处都要一致', async () => {
    const { fetchImpl, sent } = capture();
    const reqWithHistory: ModelRequest = {
      ...REQUEST_WITH_TOOL,
      messages: [
        ...REQUEST_WITH_TOOL.messages,
        {
          id: newMessageId(),
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: newCallId(), name: 'fs.read', input: {} }],
          ts: 2,
        },
      ],
    };
    await drain(
      new AnthropicProvider({ apiKey: 'k', fetchImpl }).stream(reqWithHistory, abortLike().signal),
    );

    const body = sent();
    expect((body.tools as { name: string }[])[0]?.name).toBe('fs_read');
    expect((body.tool_choice as { name: string }).name).toBe('fs_read');
    const historyBlock = (
      (body.messages as { content: { type: string; name?: string }[] }[]).at(-1)?.content ?? []
    ).find((b) => b.type === 'tool_use');
    expect(historyBlock?.name).toBe('fs_read');
  });

  it('收回来时把 wire 名解回原始能力字符串——ToolRegistry 按原名查表', async () => {
    const chunks = await drain(
      new AnthropicProvider({
        apiKey: 'k',
        fetchImpl: () =>
          Promise.resolve(
            new Response(streamOf(ANTHROPIC_TOOL_CALL_SSE), {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      }).stream(REQUEST_WITH_TOOL, abortLike().signal),
    );
    const start = chunks.find((c) => c.kind === 'tool_call_start');
    expect(start?.name).toBe('fs.read');
  });
});

describe('🔴 OpenAI 兼容：工具名过 wire 一来一回', () => {
  it('发出去时点号换成下划线——tools[]、tool_choice、历史 tool_use 三处都要一致', async () => {
    const { fetchImpl, sent } = capture();
    const reqWithHistory: ModelRequest = {
      ...REQUEST_WITH_TOOL,
      messages: [
        ...REQUEST_WITH_TOOL.messages,
        {
          id: newMessageId(),
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: newCallId(), name: 'fs.read', input: {} }],
          ts: 2,
        },
      ],
    };
    await drain(
      new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl }).stream(
        reqWithHistory,
        abortLike().signal,
      ),
    );

    const body = sent();
    expect((body.tools as { function: { name: string } }[])[0]?.function.name).toBe('fs_read');
    expect((body.tool_choice as { function: { name: string } }).function.name).toBe('fs_read');
    const historyMsg = (
      body.messages as { tool_calls?: { function: { name: string } }[] }[]
    ).find((m) => m.tool_calls !== undefined);
    expect(historyMsg?.tool_calls?.[0]?.function.name).toBe('fs_read');
  });

  it('收回来时把 wire 名解回原始能力字符串——ToolRegistry 按原名查表', async () => {
    const chunks = await drain(
      new OpenAICompatibleProvider({
        apiKey: 'k',
        fetchImpl: () =>
          Promise.resolve(
            new Response(streamOf(OPENAI_TOOL_CALL_SSE), {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      }).stream(REQUEST_WITH_TOOL, abortLike().signal),
    );
    const start = chunks.find((c) => c.kind === 'tool_call_start');
    expect(start?.name).toBe('fs.read');
  });
});
