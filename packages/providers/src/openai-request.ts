import type { Message, ModelRequest } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type { BlobStore } from '@xm/kernel';
import { blobToBase64, requireBlobs } from './blob.js';
import { ProviderHttpError } from './http.js';
import type { ToolNameCodec } from './tool-name.js';

/**
 * OpenAI 兼容 wire format 的**出站**一半：中立的块模型 → 扁平的 `messages` 数组。
 *
 * 从 `openai-compatible.ts` 里分出来，是因为那个文件顶到了单文件规模纪律
 * （docs/01 原则七 / ADR-0032）的线上。接缝取在"请求 / 响应"之间而不是别处：
 * 这两半没有共享状态，各自的正确性也由不同的东西保证——出站这一半的裁判是
 * **服务端收不收**（只有真调用能证，见 `live.test.ts`），入站那一半的裁判是
 * **我们解得对不对**（录制回放就能证）。ADR-0022 的几次补记全部落在出站这一半，
 * 不是巧合。
 */


export interface ToWireOptions {
  /** 图片块要靠它把 BlobRef 读成字节再编 base64 */
  readonly blobs?: BlobStore | undefined;
  /** 这个模型会不会思考 —— 决定 `reasoning_content` 回传闸门，见 `toWireMessages` */
  readonly thinkingModel?: boolean | undefined;
}

export async function toWire(
  req: ModelRequest,
  codec: ToolNameCodec,
  opts: ToWireOptions = {},
): Promise<Record<string, unknown>> {
  const messages: Record<string, unknown>[] = [];

  /*
   * system 段落合并成一条。`cacheable` 在这里被**刻意忽略**——
   * 这一家自动做前缀缓存，没有断点这个概念（request.ts 的注释已经预告了这一点）。
   * 忽略一个中立表达是正确的适配；把它上浮成 `ModelRequest.cacheStrategy` 才是泄漏。
   */
  if (req.system.length > 0) {
    messages.push({ role: 'system', content: req.system.map((s) => s.text).join('\n\n') });
  }

  /*
   * 「这条链路上的 reasoning_content 是不是必答题」——一次算好，整份请求共用。
   *
   * 两个来源，缺一不可：
   *   1. 能力表说这个模型会思考（`catalog.ts` 的 `thinking`）。这是**开局就生效**的那一半：
   *      哪怕第一条 assistant 就是"没有思考文本的 tool call"，字段也不会缺。
   *   2. 这段历史里**实际出现过** thinking 块。这是兜底的那一半：能力表永远追不上新模型，
   *      而"这一家真的吐过 reasoning"是比任何表都硬的证据。
   *
   * 反过来，两条都不成立时（OpenAI 官方、各类不思考的兼容端）一个字段都不会多发——
   * 这正是下面那行注释原本想守住的东西，只是它当时把"有没有思考文本"
   * 错当成了"认不认这个字段"。
   */
  const reasoningRequired =
    (opts.thinkingModel ?? false) ||
    req.messages.some((m) => m.blocks.some((b) => b.type === 'thinking'));

  for (const m of req.messages) {
    messages.push(...(await toWireMessages(m, codec, opts.blobs, reasoningRequired)));
  }

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
  /*
   * ── 关思考。**只关，不开。** ──
   *
   * 中立表达 `thinking.enabled === false` 的意思是"这次调用不要想，直接说"。
   * 会思考的模型（DeepSeek 一系）**默认开着**，而思考文本走 `reasoning_content`、
   * 同样吃 `max_tokens`——对一次只要 24 个字的调用（ADR-0038 的会话自动命名）
   * 那意味着预算全被推理吃掉、正文是空的。这不是省钱，是这类调用能不能出结果。
   *
   * 两道闸门都必要：
   *   1. `enabled === false` 才发。省略 `thinking` 的调用方（回合主循环）一个字段
   *      都不会多收，服务端默认行为原样保留。
   *   2. `reasoningRequired` 才发（判定见上面）。OpenAI 官方、Azure、各类网关不认
   *      这个参数，多发一个陌生字段的下场是整条请求 400——而它们本来也不会思考，
   *      关了也没有意义。这与 `reasoning_content` 用的是同一道闸门，不是巧合：
   *      两个字段的前提是同一件事——"这条链路说不说思考这门语言"。
   *
   * `enabled === true` 这一侧刻意不接：开思考要配预算、要抬 temperature、要接
   * 签名回传，那是一整条链路，不该顺手在这里开半条（Anthropic 那侧见 `anthropic.ts`）。
   */
  if (req.thinking?.enabled === false && reasoningRequired) {
    body.thinking = { type: 'disabled' };
  }
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
async function toWireMessages(
  m: Message,
  codec: ToolNameCodec,
  blobs: BlobStore | undefined,
  reasoningRequired: boolean,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  // 只有出现图片才会用到——这一家平时把 content 拼成一整条字符串，
  // 一旦带图片就必须换成数组形态，两种形状不能混用（见下方 content 的组装）
  const contentParts: Record<string, unknown>[] = [];
  let hasImage = false;
  const toolCalls: Record<string, unknown>[] = [];
  const reasoning: string[] = [];

  for (const b of m.blocks) {
    switch (b.type) {
      case 'text':
        textParts.push(b.text);
        contentParts.push({ type: 'text', text: b.text });
        break;
      case 'image': {
        hasImage = true;
        const data = await blobToBase64(requireBlobs(blobs), b.source);
        contentParts.push({ type: 'image_url', image_url: { url: `data:${b.source.mime};base64,${data}` } });
        break;
      }
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
      case 'document':
        unsupportedBlob(b.type);
        break;
    }
  }

  const reasoningText = reasoning.join('\n');
  const content: string | Record<string, unknown>[] = hasImage ? contentParts : textParts.join('\n');
  const contentIsEmpty = typeof content === 'string' ? content === '' : content.length === 0;

  /*
   * ── 走过 tool_calls 的那一轮，字段必须在，哪怕内容是空的 ──
   *
   * 上一版的条件是 `reasoningText !== ''`：有思考文本才带。它修好了"思考被整段丢掉"，
   * 却漏了紧挨着的另一半——模型**这一轮没吐思考、只吐了 tool_calls**。
   * DeepSeek 对这条的要求不是"有就带上"，而是"带过 tool_calls 就必须有"，
   * 缺字段一律 400（the reasoning_content ... must be passed back to the API）。
   *
   * 一次真调用问出来的三件事（`live.test.ts` 里那条用例锁着）：
   *   不带字段        → 400
   *   `null`          → 400   ← 照抄官方示例回传 `message.reasoning_content` 会踩这里，
   *                            因为无思考轮它就是 None
   *   `""`            → 200   ← 所以空串是唯一正确的空表示
   *
   * `reasoningRequired` 挡住的是另一个方向的错：不思考的兼容端不该在每一轮工具调用上
   * 都白收一个陌生字段（判定见 `toWire`）。
   */
  const includeReasoning = reasoningText !== '' || (reasoningRequired && toolCalls.length > 0);

  /*
   * ── 空正文怎么写：有 `tool_calls` 才可以是 `null` ──
   *
   * DeepSeek 的校验原文是 `Invalid assistant message: content or tool_calls must be set`：
   * 两者得有一个。`null` 在有 `tool_calls` 时是 OpenAI 的规范形状（`live.test.ts`
   * 那条对照组用的就是它，服务端收），没有 `tool_calls` 时却等于两个都没给 → 400。
   *
   * 这条真的会发生，不是理论形状：模型思考到把 `max_tokens` 用光，一句正文都没说完
   * （`turn.end reason=max_tokens`），落库的 assistant 消息**只有 thinking 块**。
   * 上面那个 `reasoningText !== ''` 分支放它进 wire，于是历史里留下一条
   * `{ content: null, reasoning_content: "...", 没有 tool_calls }`——从此这个会话
   * 每发一条都 400，用户只能弃用它。
   *
   * 所以空正文的默认写法是空串，`null` 退回它唯一有据可查的位置。
   * 与上面 `reasoning_content` 那条是同一个教训的第二次出现：**空的表示要挑对**。
   */
  const emptyContent = toolCalls.length > 0 ? null : '';

  if (!contentIsEmpty || toolCalls.length > 0 || reasoningText !== '') {
    out.unshift({
      role: m.role,
      content: typeof content === 'string' ? (content === '' ? emptyContent : content) : content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(includeReasoning ? { reasoning_content: reasoningText } : {}),
    });
  }
  return out;
}

/**
 * `image` 顶层块已经在 M1-d 接上（`toWireMessages` 的 `case 'image'` 与 ADR-0029）。
 * 这里现在只覆盖两处仍然没接的：`document` 顶层块，以及 `tool_result.content`
 * 里的 `image`/`document`（工具产出的图片，目前没有任何工具会产出，安全地搁置）。
 */
function unsupportedBlob(kind: string): never {
  throw new ProviderHttpError(
    xmError('unsupported', `多模态内容（${kind}）当前还不能发给模型（ADR-0029 遗留）。`, {
      retryable: false,
    }),
  );
}

