import type { CallId, ContentBlock, Message, ModelChunk, ModelRequest, StopReason, Usage } from '@xm/contracts';
import { newCallId, xmError } from '@xm/contracts';
import type { AbortLike, ModelCapabilities, ModelInfo, ModelProvider } from '@xm/kernel';
import { capabilitiesFor } from './catalog.js';
import type { HttpDeps } from './http.js';
import { ProviderHttpError, abortedBy, postSse } from './http.js';
import { readSseFrames } from './sse.js';

/**
 * Anthropic Messages API 适配器。
 *
 * 各家差异**在这里消化，不上浮**（端口注释的第三条规定）。本文件负责：
 * system 独立数组、`cache_control` 断点、thinking 块与 signature 的回传、
 * 增量 JSON 的分片，以及——见下——把各家自己的 tool id 换成我们的 `CallId`。
 */

const API_VERSION = '2023-06-01';

export interface AnthropicOptions extends HttpDeps {
  /** 由 SecretStore 解析后传入。**这个包不认识 SecretRef，也读不到环境变量** */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly capabilityOverrides?: Readonly<Record<string, Partial<ModelCapabilities>>>;
  /** 已知模型列表。留空则 listModels() 去打 /v1/models */
  readonly models?: readonly string[];
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly #options: AnthropicOptions;
  readonly #baseUrl: string;

  constructor(options: AnthropicOptions) {
    this.#options = options;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  capabilities(model: string): ModelCapabilities {
    return capabilitiesFor(model, this.#options.capabilityOverrides ?? {});
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const configured = this.#options.models;
    if (configured !== undefined && configured.length > 0) {
      return configured.map((id) => ({
        id,
        displayName: id,
        capabilities: this.capabilities(id),
      }));
    }

    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(`${this.#baseUrl}/v1/models`, { headers: this.#headers() });
    if (!response.ok) {
      throw new ProviderHttpError(
        xmError('provider_error', `取模型列表失败（HTTP ${String(response.status)}）。`),
      );
    }
    const body = (await response.json()) as { data?: readonly { id?: unknown; display_name?: unknown }[] };
    return (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : undefined))
      .filter((id): id is string => id !== undefined)
      .map((id) => ({ id, displayName: id, capabilities: this.capabilities(id) }));
  }

  async *stream(req: ModelRequest, signal: AbortLike): AsyncIterable<ModelChunk> {
    let body: ReadableStream<Uint8Array>;
    try {
      body = await postSse({
        url: `${this.#baseUrl}/v1/messages`,
        headers: this.#headers(),
        body: toWire(req),
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

    yield* decodeStream(body, signal);
  }

  #headers(): Record<string, string> {
    return {
      'x-api-key': this.#options.apiKey,
      'anthropic-version': API_VERSION,
    };
  }
}

// ── 请求：中立结构 → Anthropic wire format ───────────────────────

interface WireBody {
  model: string;
  max_tokens: number;
  stream: true;
  messages: unknown[];
  system?: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  thinking?: unknown;
  stop_sequences?: string[];
}

export function toWire(req: ModelRequest): WireBody {
  const body: WireBody = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    stream: true,
    messages: req.messages.map((m, i) => toWireMessage(m, i === req.cacheBreakpointAfterMessage)),
  };

  if (req.system.length > 0) {
    body.system = req.system.map((s) => ({
      type: 'text',
      text: s.text,
      // `cacheable` 是中立表达，翻译成 cache_control 是**这一层**的职责（request.ts 的注释）
      ...(s.cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  if (req.toolChoice !== undefined) {
    body.tool_choice =
      typeof req.toolChoice === 'string'
        ? { auto: { type: 'auto' }, none: { type: 'none' }, required: { type: 'any' } }[
            req.toolChoice
          ]
        : { type: 'tool', name: req.toolChoice.name };
  }

  if (req.thinking?.enabled === true) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: req.thinking.budgetTokens ?? Math.floor(req.maxOutputTokens / 2),
    };
    /*
     * 开思考时**不传 temperature**：服务端要求它必须是 1，传别的会被 400 拒绝。
     * 在这里静默丢弃是对的——temperature 是中立请求里的"偏好"，
     * 而这条约束是这一家的实现细节，不该上浮到 ContextBuilder 去判断。
     */
  } else if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }

  if (req.stopSequences !== undefined && req.stopSequences.length > 0) {
    body.stop_sequences = [...req.stopSequences];
  }

  return body;
}

function toWireMessage(m: Message, cacheHere: boolean): unknown {
  const content = m.blocks.map(toWireBlock);
  if (cacheHere && content.length > 0) {
    const last = content[content.length - 1];
    if (last !== undefined && typeof last === 'object') {
      content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
    }
  }
  return { role: m.role, content };
}

function toWireBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: b.text,
        // signature 必须原样回传，否则开启扩展思考后的多轮工具调用会被拒（block.ts 的注释）
        ...(b.signature === undefined ? {} : { signature: b.signature }),
      };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        is_error: b.isError,
        content: b.content.map((c) =>
          c.type === 'text' ? { type: 'text', text: c.text } : unsupportedBlob(c.type),
        ),
      };
    case 'image':
    case 'document':
      return unsupportedBlob(b.type);
  }
}

/**
 * 多模态是 M1-d。**在这里失败关闭，不降级成一句文字描述。**
 *
 * 把图片悄悄换成 `[图片]` 会让模型给出一个自信但完全没看过图的回答，
 * 而用户看到的是"它读了我的截图"。看不见的降级比报错危险得多。
 */
function unsupportedBlob(kind: string): never {
  throw new ProviderHttpError(
    xmError('unsupported', `多模态内容（${kind}）要到 M1-d 才接上，当前不能发给模型。`, {
      retryable: false,
    }),
  );
}

// ── 响应：SSE → 中立 ModelChunk ─────────────────────────────────

/**
 * 把 Anthropic 的事件流解成中立 chunk。
 *
 * 两件在这里做掉、不让它们上浮的事：
 *
 * **一、tool id 换成我们的 `CallId`。** 服务端给的是 `toolu_01A…`，而 `CallId` 是
 * 品牌化的 UUID（`base/ids.ts`）——事件 payload 校验会直接拒掉非 UUID。
 * 换 id 是安全的：我们每轮把完整对话重新送上去，`tool_use.id` 与 `tool_result.tool_use_id`
 * 在**同一个请求内**保持一致即可，服务端不会拿它跟历史比对。
 *
 * **二、usage 只发一条。** 服务端分两处给（`message_start` 给输入侧、`message_delta`
 * 给输出侧），而 Turn 循环每收到一个 usage chunk 就记一条 `usage.recorded`——
 * 发两条就等于把一次请求记成两次，成本翻倍且无法事后分辨。
 */
export async function* decodeStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortLike,
): AsyncGenerator<ModelChunk, void, undefined> {
  const callIds = new Map<string, CallId>();
  const blockKinds = new Map<number, 'text' | 'thinking' | 'tool_use'>();
  const blockCalls = new Map<number, CallId>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason: StopReason = 'end_turn';
  let aborted = false;

  try {
    for await (const frame of readSseFrames(body)) {
      const data = parseJson(frame.data);
      if (data === undefined) continue;

      switch (frame.event) {
        case 'message_start': {
          const u = pick(pick(data, 'message'), 'usage');
          usage = { ...usage, ...readUsage(u) };
          break;
        }

        case 'content_block_start': {
          const index = num(data.index);
          const block = pick(data, 'content_block');
          if (index === undefined || block === undefined) break;
          const type = str(block.type);

          if (type === 'tool_use') {
            const rawId = str(block.id) ?? '';
            const name = str(block.name) ?? '';
            const callId = callIds.get(rawId) ?? newCallId();
            callIds.set(rawId, callId);
            blockKinds.set(index, 'tool_use');
            blockCalls.set(index, callId);
            yield { kind: 'tool_call_start', id: callId, name };
          } else if (type === 'thinking') {
            blockKinds.set(index, 'thinking');
          } else {
            blockKinds.set(index, 'text');
          }
          break;
        }

        case 'content_block_delta': {
          const index = num(data.index);
          const delta = pick(data, 'delta');
          if (index === undefined || delta === undefined) break;

          switch (str(delta.type)) {
            case 'text_delta': {
              const text = str(delta.text);
              if (text !== undefined && text !== '') yield { kind: 'text_delta', text };
              break;
            }
            case 'thinking_delta': {
              const text = str(delta.thinking);
              if (text !== undefined && text !== '') yield { kind: 'thinking_delta', text };
              break;
            }
            case 'signature_delta': {
              const signature = str(delta.signature);
              if (signature !== undefined) yield { kind: 'thinking_signature', signature };
              break;
            }
            case 'input_json_delta': {
              const callId = blockCalls.get(index);
              const argsJson = str(delta.partial_json);
              if (callId !== undefined && argsJson !== undefined) {
                yield { kind: 'tool_call_delta', id: callId, argsJson };
              }
              break;
            }
            default:
              // 未知的 delta 类型：忽略。上游加一种新块不该让会话崩掉
              break;
          }
          break;
        }

        case 'content_block_stop': {
          const index = num(data.index);
          if (index === undefined) break;
          const callId = blockCalls.get(index);
          if (callId !== undefined) yield { kind: 'tool_call_end', id: callId };
          break;
        }

        case 'message_delta': {
          const delta = pick(data, 'delta');
          const reason = delta === undefined ? undefined : str(delta.stop_reason);
          if (reason !== undefined) stopReason = mapStopReason(reason);
          const u = pick(data, 'usage');
          if (u !== undefined) usage = { ...usage, ...readUsage(u) };
          break;
        }

        case 'error': {
          const err = pick(data, 'error');
          const message = (err === undefined ? undefined : str(err.message)) ?? '模型侧报错。';
          throw new ProviderHttpError(xmError('provider_error', message));
        }

        case 'message_stop':
        case 'ping':
        default:
          break;
      }
    }
  } catch (e) {
    /*
     * 端口约定：取消时**正常结束迭代，不抛**（见 model-provider.ts）。
     * 这条不是洁癖——真实 fetch 在 abort 时让正文读取抛 `AbortError`，
     * 而调用方分辨"取消 vs 真错"分辨错一次，用户点停止就会收到一条红色报错。
     *
     * 不是取消造成的异常照常往外抛：那才是真的出错了。
     */
    if (signal === undefined || !abortedBy(signal)) throw e;
    aborted = true;
  }

  if (aborted) {
    // 中断时**不发 usage**：服务端没给最终用量，编一个 outputTokens: 0 出来
    // 就是把"不知道"写成"是零"
    yield { kind: 'stop', reason: 'aborted' };
    return;
  }

  yield { kind: 'usage', usage };
  yield { kind: 'stop', reason: stopReason };
}

/**
 * `refusal` 与 `pause_turn` 在我们的闭集里没有对应值。
 *
 * 归到 `end_turn` 而不是 `error`：两者都不是失败——模型正常地结束了这一段输出，
 * 拒答的理由就在正文里，用户看得见。记成 error 会让 UI 显示一个红色的失败态，
 * 而实际上没有任何东西出错。
 */
function mapStopReason(raw: string): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

function readUsage(u: Record<string, unknown> | undefined): Partial<Usage> {
  if (u === undefined) return {};
  const out: Partial<Usage> = {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return out;
}

// ── 小工具：JSON 的取值全部失败关闭为 undefined ──────────────────

export function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const pick = (o: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined => {
  const v = o?.[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function pickHttpDeps(o: HttpDeps): HttpDeps {
  return {
    ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
    ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
    ...(o.maxRetries === undefined ? {} : { maxRetries: o.maxRetries }),
    ...(o.retryBaseMs === undefined ? {} : { retryBaseMs: o.retryBaseMs }),
  };
}
