import { describe, expect, it } from 'vitest';
import type { ModelChunk, ModelRequest, ToolDescriptor } from '@xm/contracts';
import { CallId, DEFAULT_RESULT_LIMITS, newMessageId, redact } from '@xm/contracts';
import type { ModelProvider } from '@xm/kernel';
import { AnthropicProvider, OpenAICompatibleProvider, ProviderHttpError } from '@xm/providers';
import { abortLike } from './helpers/stream.js';

/**
 * 真实 Provider 验收。**默认整组跳过，CI 永不运行。**
 *
 * ── 为什么这组用例必须存在，而 `recorded.test.ts` 不够 ──
 *
 * 录制回放证明「我们能解真实字节」，但它证明不了三件事：
 *
 *   1. 我们**发出去**的请求体是对方接受的（录制只覆盖响应方向）
 *   2. 点停止后连接**真的**断了（录制里的流是我们自己造的，想让它什么时候停都行）
 *   3. 真实的失败长什么样（401 / 400 的正文、状态码、以及密钥有没有回显）
 *
 * 第 2 条是 M1 DoD 里「点停止 200ms 内真停」的唯一真实证明。造出来的流永远会
 * 配合我们停下——只有真的 TCP 连接才可能不配合。
 *
 * 跑法：
 *
 * ```
 * XM_LIVE_PROVIDER=1 \
 * XM_LIVE_API_KEY=…  \
 * XM_LIVE_ANTHROPIC_BASE=https://api.deepseek.com/anthropic \
 * XM_LIVE_OPENAI_BASE=https://api.deepseek.com/v1 \
 * XM_LIVE_MODEL=deepseek-v4-flash \
 * pnpm vitest run packages/providers/tests/live.test.ts
 * ```
 *
 * **密钥只从环境变量进来，不许有默认值、不许落任何文件。** 这个包的源码读不到
 * `process.env`（depcruise 钉着），所以只有测试文件能做这件事——而测试文件不会被打包。
 */

const LIVE = process.env.XM_LIVE_PROVIDER === '1';
const API_KEY = process.env.XM_LIVE_API_KEY ?? '';
const ANTHROPIC_BASE = process.env.XM_LIVE_ANTHROPIC_BASE ?? '';
const OPENAI_BASE = process.env.XM_LIVE_OPENAI_BASE ?? '';
const MODEL = process.env.XM_LIVE_MODEL ?? '';

/** 一次真调用给 90 秒：真实模型会思考，而 vitest 默认的 5 秒是给纯函数的 */
const SLOW = 90_000;

const ask = (text: string, maxOutputTokens = 128): ModelRequest => ({
  model: MODEL,
  system: [{ text: '你是一个测试助手，回答尽量简短。', cacheable: true }],
  messages: [{ id: newMessageId(), role: 'user', blocks: [{ type: 'text', text }], ts: Date.now() }],
  maxOutputTokens,
});

/**
 * 一个完整的 `ToolDescriptor`。
 *
 * 只有 `name` / `description` / `inputSchema` 三个字段会被适配器写进 wire format，
 * 其余（risk、capabilities、resultLimits…）是权限与结果裁剪要用的，Provider 一律不看。
 * 写全是因为类型要求写全——**而类型要求写全本身就是一条保证**：
 * 新增一个工具时不可能"忘了标 risk"，那会编译不过。
 */
const WEATHER_TOOL: ToolDescriptor = {
  name: 'weather.get',
  group: 'weather',
  description: '查询某个城市的天气',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
  risk: 'safe',
  capabilities: ['net.fetch'],
  concurrency: 'parallel',
  resultLimits: DEFAULT_RESULT_LIMITS,
  source: { kind: 'builtin' },
};

async function drain(it: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const textOf = (chunks: readonly ModelChunk[]): string =>
  chunks.map((c) => (c.kind === 'text_delta' ? c.text : '')).join('');

const argsOf = (chunks: readonly ModelChunk[]): string =>
  chunks.map((c) => (c.kind === 'tool_call_delta' ? c.argsJson : '')).join('');

interface Target {
  readonly label: string;
  readonly make: (key?: string) => ModelProvider;
}

const TARGETS: readonly Target[] = [
  {
    label: 'anthropic 兼容端点',
    make: (key = API_KEY) => new AnthropicProvider({ apiKey: key, baseUrl: ANTHROPIC_BASE }),
  },
  {
    label: 'openai 兼容端点',
    make: (key = API_KEY) =>
      new OpenAICompatibleProvider({ apiKey: key, baseUrl: OPENAI_BASE, id: 'deepseek' }),
  },
];

describe.skipIf(!LIVE)('真实 Provider 验收', () => {
  it('环境变量齐全（缺一样就不该继续，免得后面报一堆无关的错）', () => {
    expect(API_KEY, 'XM_LIVE_API_KEY').not.toBe('');
    expect(ANTHROPIC_BASE, 'XM_LIVE_ANTHROPIC_BASE').not.toBe('');
    expect(OPENAI_BASE, 'XM_LIVE_OPENAI_BASE').not.toBe('');
    expect(MODEL, 'XM_LIVE_MODEL').not.toBe('');
  });

  describe.each(TARGETS)('$label', ({ make }) => {
    it(
      '发得出、收得回：文本、usage 恰好一条、stop 收尾',
      async () => {
        const chunks = await drain(make().stream(ask('只回复两个字：收到'), abortLike().signal));

        expect(textOf(chunks).length).toBeGreaterThan(0);

        const usage = chunks.filter((c) => c.kind === 'usage');
        expect(usage, 'usage 发两条就等于把一次请求记成两次').toHaveLength(1);
        expect(usage[0]?.kind === 'usage' && usage[0].usage.inputTokens).toBeGreaterThan(0);
        expect(usage[0]?.kind === 'usage' && usage[0].usage.outputTokens).toBeGreaterThan(0);

        expect(chunks.at(-1)?.kind).toBe('stop');
        expect(chunks.filter((c) => c.kind === 'stop')).toHaveLength(1);
      },
      SLOW,
    );

    it(
      '工具调用：id 是合法 CallId，增量参数拼得出合法 JSON',
      async () => {
        const req: ModelRequest = { ...ask('北京天气怎么样？用工具查。', 512), tools: [WEATHER_TOOL] };
        const chunks = await drain(make().stream(req, abortLike().signal));

        const start = chunks.find((c) => c.kind === 'tool_call_start');
        expect(start, '模型没调工具，这次验收无效——换个问法重跑').toBeDefined();
        expect(start).toMatchObject({ name: WEATHER_TOOL.name });

        // 服务端给的是 `call_00_…` / `toolu_…`，都不是 UUID。没重映射的话这里当场炸
        const id = start?.kind === 'tool_call_start' ? start.id : '';
        expect(() => CallId.parse(id)).not.toThrow();

        // 拼不回合法 JSON 说明分片边界处理错了——这是最容易在真实网络下才暴露的一类
        expect(() => JSON.parse(argsOf(chunks)) as unknown).not.toThrow();
        expect(JSON.parse(argsOf(chunks))).toMatchObject({ city: expect.any(String) as unknown });

        expect(chunks.filter((c) => c.kind === 'tool_call_end')).toHaveLength(1);
        expect(chunks.at(-1)).toMatchObject({ kind: 'stop', reason: 'tool_use' });
      },
      SLOW,
    );

    /**
     * **M1 DoD 那条「点停止 200ms 内真停」的唯一真实证明。**
     *
     * 造出来的流永远配合我们停下；只有真 TCP 连接才可能不配合。这条断言的是
     * `AbortLike → AbortSignal` 桥接确实穿透到了 fetch，而不是"等下一个 chunk
     * 到达时才发现该停了"——后者在模型卡进一段长思考时会拖到三十秒。
     */
    it(
      '点停止后 200ms 内真的停下（迭代器结束，不是等下一个 chunk）',
      async () => {
        const { signal, abort } = abortLike();
        const stream = make().stream(ask('写一篇 800 字的散文，讲讲夏天。', 2048), signal);

        let firstChunkAt = 0;
        let abortedAt = 0;
        let received = 0;

        for await (const chunk of stream) {
          received += 1;
          void chunk;
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          // 收满一点再停，确保连接确实处在"正在流"的状态
          if (received === 5) {
            abortedAt = Date.now();
            abort();
          }
        }
        const stoppedAt = Date.now();

        expect(abortedAt, '一条 chunk 都没收到，这次验收无效').toBeGreaterThan(0);
        expect(stoppedAt - abortedAt).toBeLessThan(200);
      },
      SLOW,
    );
  });

  /**
   * 端口中立性，这次的对手是**真实服务端**而不是我们写的 fixture。
   *
   * 不比逐条 chunk：两次调用是两次不同的生成，文字必然不同。比的是
   * **中立形状**——同一个 `ModelRequest` 两边都发得出去，都能解出同一组 chunk 种类，
   * usage / stop 的位置与条数一致。差异一旦上浮到端口，这里就会不一致。
   */
  it(
    '同一个 ModelRequest 喂两家，中立形状一致',
    async () => {
      const req = ask('用一句话介绍你自己。');
      const [a, b] = await Promise.all(TARGETS.map(async (t) => drain(t.make().stream(req, abortLike().signal))));

      for (const chunks of [a, b]) {
        expect(chunks).toBeDefined();
        expect(chunks?.filter((c) => c.kind === 'usage')).toHaveLength(1);
        expect(chunks?.at(-1)?.kind).toBe('stop');
        expect(textOf(chunks ?? []).length).toBeGreaterThan(0);
      }

      // 两边解出的 chunk 种类集合（去掉各家真实的能力差异）必须相同
      const kinds = (chunks: readonly ModelChunk[]): string[] =>
        [...new Set(chunks.map((c) => c.kind))].filter((k) => k !== 'thinking_signature').sort();
      expect(kinds(a ?? [])).toEqual(kinds(b ?? []));
    },
    SLOW,
  );

  /**
   * 真实的失败长什么样。
   *
   * 两件事在这里被验：401 归成**不可重试**（重试一个错 key 只会把限流额度烧掉），
   * 以及——错误消息里不能出现密钥。服务端**自己也会**打码，但打多少是对方决定的，
   * 我们见过它只遮前面留后四位。所以 `readErrorBody()` 那道 redact 是我们自己的底。
   */
  it(
    '错 key → 不可重试的 provider_error，且密钥不出现在错误里',
    async () => {
      // 形状像真 key（redact 的 sk- 规则要求 32 位以上），但不是真的
      const fake = `sk-${'0123456789abcdef'.repeat(2)}`;

      for (const target of TARGETS) {
        const provider = target.make(fake);
        const error = await drain(provider.stream(ask('hi', 16), abortLike().signal)).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error, `${target.label}：错 key 居然没报错`).toBeInstanceOf(ProviderHttpError);
        const xm = (error as ProviderHttpError).xm;
        expect(xm.code).toBe('provider_error');
        expect(xm.retryable, '重试一个错 key 只会烧限流额度').toBe(false);

        const serialized = JSON.stringify(redact(xm));
        expect(serialized, `${target.label}：密钥泄漏进了错误消息`).not.toContain(fake);
      }
    },
    SLOW,
  );
});
