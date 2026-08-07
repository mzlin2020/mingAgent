import type { CallId, Message, ModelChunk, ModelRequest, StopReason, Usage } from '@xm/contracts';
import { newCallId, xmError } from '@xm/contracts';
import type { AbortLike, ModelCapabilities, ModelInfo, ModelProvider } from '@xm/kernel';
import { capabilitiesFor } from './catalog.js';
import { parseJson, pickHttpDeps } from './anthropic.js';
import type { HttpDeps } from './http.js';
import { ProviderHttpError, abortedBy, postSse } from './http.js';
import { readSseFrames } from './sse.js';
import type { ToolNameCodec } from './tool-name.js';
import { buildToolNameCodec } from './tool-name.js';

/**
 * OpenAI 兼容适配器（官方 OpenAI、以及一大批照抄它 wire format 的服务）。
 *
 * ── 这个文件存在的首要理由不是"多支持一家" ──
 *
 * `ModelProvider` 端口写着「各家的差异全部在适配器里消化，不上浮」。在只有一个实现的
 * 时候，这句话是**无法证伪的**：任何绑死 Anthropic 的假设都会舒舒服服地待在端口里，
 * 直到接第二家时才暴露，而那时上面已经压着 ContextBuilder、压缩、缓存断点。
 *
 * 接第二家的过程本身就抓到了三处：块模型 → 扁平 content 的转换、
 * 工具结果要从 user 消息里**拆成独立消息**、以及思考块无法回传。三处都在本文件里，
 * 没有一处泄漏到 `ModelRequest`。
 */

export interface OpenAICompatibleOptions extends HttpDeps {
  readonly apiKey: string;
  /** 兼容服务必填，如 `https://api.deepseek.com/v1`。官方 OpenAI 可省 */
  readonly baseUrl?: string;
  readonly id?: string;
  readonly capabilityOverrides?: Readonly<Record<string, Partial<ModelCapabilities>>>;
  readonly models?: readonly string[];
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #options: OpenAICompatibleOptions;
  readonly #baseUrl: string;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id ?? 'openai';
    this.#options = options;
    this.#baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  capabilities(model: string): ModelCapabilities {
    return capabilitiesFor(model, this.#options.capabilityOverrides ?? {});
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const configured = this.#options.models;
    if (configured !== undefined && configured.length > 0) {
      return configured.map((id) => ({ id, displayName: id, capabilities: this.capabilities(id) }));
    }

    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(`${this.#baseUrl}/models`, { headers: this.#headers() });
    if (!response.ok) {
      throw new ProviderHttpError(
        xmError('provider_error', `取模型列表失败（HTTP ${String(response.status)}）。`),
      );
    }
    const body = (await response.json()) as { data?: readonly { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : undefined))
      .filter((id): id is string => id !== undefined)
      .map((id) => ({ id, displayName: id, capabilities: this.capabilities(id) }));
  }

  async *stream(req: ModelRequest, signal: AbortLike): AsyncIterable<ModelChunk> {
    // 同一份表管全程：发出去按它编，收回来按它解——两处用不同的表就是分叉的开始
    const codec = buildToolNameCodec((req.tools ?? []).map((t) => t.name));

    let body: ReadableStream<Uint8Array>;
    try {
      body = await postSse({
        url: `${this.#baseUrl}/chat/completions`,
        headers: this.#headers(),
        body: toWire(req, codec),
        signal,
        providerId: this.id,
        ...pickHttpDeps(this.#options),
      });
    } catch (e) {
      // 连接还没建起来就被取消：照样按端口约定收尾，不把 AbortError 抛给调用方
      if (!abortedBy(signal)) throw e;
      yield { kind: 'stop', reason: 'aborted' };
      return;
    }

    yield* decodeStream(body, signal, codec);
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#options.apiKey}` };
  }
}

// ── 请求 ────────────────────────────────────────────────────────

export function toWire(req: ModelRequest, codec: ToolNameCodec): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  /*
   * system 段落合并成一条。`cacheable` 在这里被**刻意忽略**——
   * 这一家自动做前缀缓存，没有断点这个概念（request.ts 的注释已经预告了这一点）。
   * 忽略一个中立表达是正确的适配；把它上浮成 `ModelRequest.cacheStrategy` 才是泄漏。
   */
  if (req.system.length > 0) {
    messages.push({ role: 'system', content: req.system.map((s) => s.text).join('\n\n') });
  }

  for (const m of req.messages) messages.push(...toWireMessages(m, codec));

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    // 不加这个就拿不到 usage，成本展示会永远是 0
    stream_options: { include_usage: true },
    max_tokens: req.maxOutputTokens,
  };

  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: codec.encode(t.name), description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice =
      typeof req.toolChoice === 'string'
        ? req.toolChoice
        : { type: 'function', function: { name: codec.encode(req.toolChoice.name) } };
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined && req.stopSequences.length > 0) {
    body.stop = [...req.stopSequences];
  }

  return body;
}

/**
 * 一条中立消息可能变成**好几条** OpenAI 消息。
 *
 * 工具结果在我们的形状里是 user 消息中的 `tool_result` 块（对齐 Anthropic），
 * 而这一家要求每个结果是一条独立的 `role: 'tool'` 消息。这正是"块模型拆成扁平结构容易、
 * 反过来难"（block.ts 的注释）的具体一例——差异被这个函数吃掉了。
 */
function toWireMessages(m: Message, codec: ToolNameCodec): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const text: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  const reasoning: string[] = [];

  for (const b of m.blocks) {
    switch (b.type) {
      case 'text':
        text.push(b.text);
        break;
      case 'tool_use':
        // 历史消息里的 tool_use 也要按同一份表编码——不然同一个工具在 tools[]
        // 里叫 fs_read，在历史 tool_calls 里却叫 fs.read，两边对不上
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: codec.encode(b.name), arguments: JSON.stringify(b.input ?? {}) },
        });
        break;
      case 'tool_result':
        out.push({
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.content
            .map((c) => (c.type === 'text' ? c.text : unsupportedBlob(c.type)))
            .join('\n'),
        });
        break;
      case 'thinking':
        /*
         * 思考文本要挂回这条 assistant 消息的 `reasoning_content`——上一版注释里
         * 说"这一家收不回自己的推理内容，硬塞会被 400 拒"，那是凭直觉写的，
         * 从没拿真实请求验证过。真实结果正相反：DeepSeek 思考模式下，一旦
         * 这一轮带过 tool_calls，下一轮请求**不带**上一轮的 reasoning_content
         * 才会被 400 拒（"the reasoning_content ... must be passed back to
         * the API"）。这是文档 Tool Calls 一节写明的强制项，不是可选优化。
         * https://api-docs.deepseek.com/guides/thinking_mode
         */
        reasoning.push(b.text);
        break;
      case 'redacted_thinking':
        /*
         * 加密思考块是 Anthropic 私有格式（`signature`/`data` 对它自己的模型
         * 才有意义），这一家的 wire format 里没有对应位置可放，继续丢弃。
         * 与上面 thinking 的区别只在"有没有地方接住"，不是"要不要接住"。
         */
        break;
      case 'image':
      case 'document':
        unsupportedBlob(b.type);
        break;
    }
  }

  const content = text.join('\n');
  const reasoningText = reasoning.join('\n');
  if (content !== '' || toolCalls.length > 0 || reasoningText !== '') {
    out.unshift({
      role: m.role,
      content: content === '' ? null : content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      // 只有真出现过思考文本才带这个字段——不认它的兼容端不该无端多收一个陌生字段
      ...(reasoningText !== '' ? { reasoning_content: reasoningText } : {}),
    });
  }
  return out;
}

function unsupportedBlob(kind: string): never {
  throw new ProviderHttpError(
    xmError('unsupported', `多模态内容（${kind}）要到 M1-d 才接上，当前不能发给模型。`, {
      retryable: false,
    }),
  );
}

// ── 响应 ────────────────────────────────────────────────────────

export async function* decodeStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortLike | undefined,
  codec: ToolNameCodec,
): AsyncGenerator<ModelChunk, void, undefined> {
  /** OpenAI 的 tool_calls 用 `index` 定位，`id` 只在第一个分片出现 */
  const callByIndex = new Map<number, CallId>();
  const started = new Set<number>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason: StopReason = 'end_turn';
  let aborted = false;

  try {
    for await (const frame of readSseFrames(body)) {
      // 这一家用 `data: [DONE]` 收尾，不是一个 JSON
      if (frame.data.trim() === '[DONE]') break;
      const data = parseJson(frame.data);
      if (data === undefined) continue;

      const err = data.error;
      if (typeof err === 'object' && err !== null) {
        const message = str((err as Record<string, unknown>).message) ?? '模型侧报错。';
        throw new ProviderHttpError(xmError('provider_error', message));
      }

      const u = data.usage;
      if (typeof u === 'object' && u !== null) usage = { ...usage, ...readUsage(u as Record<string, unknown>) };

      const choices = data.choices;
      if (!Array.isArray(choices)) continue;
      const choice = choices[0] as Record<string, unknown> | undefined;
      if (choice === undefined) continue;

      const finish = str(choice.finish_reason);
      if (finish !== undefined) stopReason = mapStopReason(finish);

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta === undefined) continue;

      const content = str(delta.content);
      if (content !== undefined && content !== '') yield { kind: 'text_delta', text: content };

      /*
       * 兼容服务把推理内容放在 `reasoning_content`（DeepSeek 系）或 `reasoning`（其余）。
       * 两个都认，因为它们都是"同一件事的不同拼写"——正是适配器该消化的那类差异。
       */
      const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
      if (reasoning !== undefined && reasoning !== '') {
        yield { kind: 'thinking_delta', text: reasoning };
      }

      const toolCalls = delta.tool_calls;
      if (!Array.isArray(toolCalls)) continue;

      for (const raw of toolCalls) {
        const tc = raw as Record<string, unknown>;
        const index = num(tc.index) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;

        let callId = callByIndex.get(index);
        if (callId === undefined) {
          // 换成我们的 CallId，理由同 anthropic.ts：CallId 是品牌化 UUID，`call_abc123` 过不了校验
          callId = newCallId();
          callByIndex.set(index, callId);
        }

        // 服务端回传的是我们编码过的 wire 名，解回内部名再往上层走——
        // ToolRegistry 按内部名（能力字符串）查表，收不到原名就找不到工具
        const name = fn === undefined ? undefined : str(fn.name);
        if (name !== undefined && name !== '' && !started.has(index)) {
          started.add(index);
          yield { kind: 'tool_call_start', id: callId, name: codec.decode(name) };
        }

        const args = fn === undefined ? undefined : str(fn.arguments);
        if (args !== undefined && args !== '') {
          yield { kind: 'tool_call_delta', id: callId, argsJson: args };
        }
      }
    }
  } catch (e) {
    // 端口约定：取消时正常结束迭代，不抛。理由见 anthropic.ts 同名处与 model-provider.ts
    if (signal === undefined || !abortedBy(signal)) throw e;
    aborted = true;
  }

  if (aborted) {
    /*
     * 中断时**不发 usage**，也**不补 tool_call_end**。
     *
     * 后者尤其要紧：一个被截断的 tool_call 的参数 JSON 必然是残缺的
     * （录制里能看到参数是一个字符一个字符来的），补上 end 等于告诉上层
     * "这个调用完整了"，而 `parseArgs` 会拿到半截 JSON。
     */
    yield { kind: 'stop', reason: 'aborted' };
    return;
  }

  for (const callId of callByIndex.values()) yield { kind: 'tool_call_end', id: callId };
  yield { kind: 'usage', usage };
  yield { kind: 'stop', reason: stopReason };
}

function mapStopReason(raw: string): StopReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

function readUsage(u: Record<string, unknown>): Partial<Usage> {
  const out: Partial<Usage> = {};
  const input = num(u.prompt_tokens);
  const output = num(u.completion_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;

  const details = u.prompt_tokens_details;
  if (typeof details === 'object' && details !== null) {
    const cached = num((details as Record<string, unknown>).cached_tokens);
    if (cached !== undefined) {
      out.cacheReadTokens = cached;
      /*
       * 这一家把缓存命中的 token **也算在** prompt_tokens 里，Anthropic 则是分开报的。
       * 不减掉的话同一段对话在两家之间的输入 token 数不可比，成本也会算重。
       */
      if (out.inputTokens !== undefined) out.inputTokens = Math.max(0, out.inputTokens - cached);
    }
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
