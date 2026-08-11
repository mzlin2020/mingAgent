import type { ModelRequest } from '@xm/contracts';
import { newMessageId } from '@xm/contracts';
import type { AbortLike, ModelProvider, SessionState } from '@xm/kernel';
import { drainText } from './drain-text.js';
import type { SessionRuntime } from './session-runtime.js';

/**
 * 会话自动命名（ADR-0038）。
 *
 * 新建的会话此前永远叫「新会话」或目录名，Home 列表与顶栏 tabs 于是全是同名条目
 * （ADR-0037 的「后果·负面」已经预告过这条）。这个模块负责：拿用户的**第一条消息**，
 * 让一个小模型起个短标题，净化之后记一条 `session.renamed`。
 *
 * ── 三条刻意的边界 ──
 *
 * **一、输入只有用户那一句话。** 模型输出与工具结果永不参与命名。标题会显示在
 * 顶栏 tab 上，而 `docs/01` 原则四说模型输出是不可信输入——让一段可能读过网页的
 * 助手回复参与命名，等于把一条 UI 文本的控制权交给外部内容。同理也不给 cwd、
 * 不给会话历史、不给工具列表：命名的输入面就是那一句话。
 *
 * **二、它不是子 Agent，也不是插件。** 隔离靠模块边界就够：自带 system prompt、
 * 自带模型槽位（`config.model.summarize`）、自带取消源，请求里 `tools` 省略，
 * 产出**永远不进 `state.messages`**——只进 `session.renamed` 的 payload。
 * 真做成子 Agent 会撞上 ADR-0033 的失败关闭闸门（`subagent.*` 一写就抛），
 * 那需要先实现 G2 污点传播（M2）；插件宿主是 M3。没有载体就不写实现。
 *
 * **三、模型起的标题是不可信输入。** `sanitizeTitle()` 是这条路径上唯一的护栏——
 * 契约层对标题零约束（`SessionRenamedPayload` 只有 `z.string()`），存储层也不管。
 * 绕过它直接 record，换行、ANSI 转义、RTL override、2000 字长串都能进 tab。
 */

/**
 * 标题长度硬上限，**按码点算**。
 *
 * 与 prompt 里要求的"中文不超过 12 字"是两个不同的数字，刻意的：
 * prompt 是**请求**（模型可能不听），这里是**保证**。顶栏 tab 是
 * `max-w-[12rem] truncate`，12 字刚好不被截，24 是给模型的冗余。
 */
export const MAX_TITLE_CHARS = 24;

/** 送进模型的用户文本上限（码点）。命名不需要读完一篇长文 */
export const MAX_TITLE_INPUT_CHARS = 2000;

/** 24 个中文字远在其下；给足冗余，同时保证跑飞的模型也只烧这么多 */
export const TITLE_MAX_OUTPUT_TOKENS = 64;

/** 调命名文案只改这里 */
export const TITLE_SYSTEM_PROMPT = [
  '你在给一个 AI 助手会话起标题。用户会给你他在这个会话里说的第一句话。',
  '规则：',
  '1. 只输出标题本身。不要解释、不要引号、不要 Markdown、结尾不要标点。',
  '2. 用与用户相同的语言。中文不超过 12 个字，英文不超过 6 个词。',
  '3. 概括他想做的事，不要复述原话；不要把完整的代码、路径、URL 抄进标题。',
  '4. 看不出他想做什么，就给一个 4 个字以内最泛的概括（例如“闲聊”）。',
].join('\n');

/**
 * 该不该给这个会话自动起名。
 *
 * ── 顺序即判据 ──
 *
 * 必须在 `runTurn()` 写下 `turn.start` **之前**求值。`reduce()` 的 `turn.start`
 * 分支是用户消息进入 `state.messages` 的唯一途径，而 `turn.start` 是 `runTurn()`
 * 记的第一条事件——所以"messages 里还没有 user 消息"精确等价于"这是第一条"。
 * 挪到回合之后再判，判据当场失真。`autoTitleSession()` 在第一个 `await` 之前
 * 就调它，因此调用方即使写成 `void autoTitleSession(...)` 也仍然是在调用那一瞬间求值。
 *
 * 写成 `some(role === 'user')` 而不是 `messages.length === 0`：判据的原话是
 * "第一条**用户**消息"，将来若出现预置的开场白，长度判据会当场读错。
 *
 * **不看 `state.title`**：从目录创建的会话标题是目录名，同一个仓库开三次照样撞名，
 * 内容标题信息量更大，所以它也要被改（ADR-0038 取舍三）。也正因为判据只看
 * "有没有用户消息"，第二条消息进来时它自然为 false——结构上不可能重复命名，
 * 不需要一个"已经命名过"的标记。
 */
export function shouldAutoTitle(state: SessionState, text: string): boolean {
  // 只贴了图没打字：没有可命名的文本，而模型输出永不参与命名
  if (text.trim() === '') return false;
  return !state.messages.some((m) => m.role === 'user');
}

/** 按**码点**截断。`String.slice` 会把代理对切成孤立代理项，落库后显示成替换字符 */
function truncateByCodePoint(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('')}…`;
}

/** 成对包裹符：模型很爱把标题包起来，即便 prompt 里说了不要 */
const WRAPPERS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['【', '】'],
];

function unwrap(value: string): string {
  for (const [open, close] of WRAPPERS) {
    if (value.length >= open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  return value;
}

/**
 * 模型输出 → 可以放进 tab 的标题。**不合格返回 `undefined`，调用方一条事件都不发。**
 *
 * 这是本路径上唯一的护栏，逐条挡的东西：
 *
 *   1. 取第一段非空行 —— 模型多说的解释、标题里的换行（含 U+2028/U+2029）
 *   2. 控制字符 —— NUL/BEL、以 ESC 引导的 ANSI/OSC 序列（M3 的 CLI 里这类序列
 *      真能改终端标题，不是理论风险）
 *   3. 不可见与双向控制符 —— RTL override 能让 tab 上显示成完全另一串
 *   4. 去包裹、去「标题：」前缀
 *   5. 空白折叠
 *   6. 一个字母数字都没有 → 判为空。空标题会让 UI 显示"未命名"，比原来的"新会话"更糟
 *   7. 按码点截断
 */
export function sanitizeTitle(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r\n|\r|\n|\u2028|\u2029/u)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return undefined;

  let title = firstLine
    // eslint-disable-next-line no-control-regex -- 挡的就是控制字符本身，这里必须写得出它们
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu, '');

  // 去包裹 → 去标签 → 再去一次包裹：`标题："读取目录"` 需要两轮才剥干净
  title = unwrap(title.trim());
  title = title.replace(/^(标题|题目|title)\s*[:：]\s*/iu, '');
  title = unwrap(title.trim());

  title = title.replace(/\s+/gu, ' ').trim();

  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;

  return truncateByCodePoint(title, MAX_TITLE_CHARS);
}

export function buildTitleRequest(model: string, text: string): ModelRequest {
  return {
    model,
    /*
     * 单段、`cacheable: false`：这次调用每个会话只发生一次，声明"到这里为止是
     * 稳定前缀"没有任何人会去命中它，那只是一句谎话。
     */
    system: [{ text: TITLE_SYSTEM_PROMPT, cacheable: false }],
    messages: [
      {
        id: newMessageId(),
        role: 'user',
        blocks: [{ type: 'text', text: truncateByCodePoint(text, MAX_TITLE_INPUT_CHARS) }],
        // 这条消息只活在这一次请求里，不进任何事件流，时间戳没有意义
        ts: 0,
      },
    ],
    /*
     * `tools` 整个字段省略，不是给一个空数组：适配器判的是"有没有且非空"，
     * 但各家兼容端点对空数组的行为并不一致，省略是唯一没有歧义的写法。
     *
     * `thinking` 也必须不开：开了之后 Anthropic 要求 temperature 为 1
     * 且思考预算至少 1024，而那远大于这里的 maxOutputTokens，服务端直接 400。
     */
    maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    // 同一句话应当得到同一个标题
    temperature: 0,
  };
}

export interface AutoTitleDeps {
  readonly runtime: SessionRuntime;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly signal?: AbortLike;
}

/**
 * 端到端：判据 → 调模型 → 净化 → 记 `session.renamed`。
 *
 * **必须在 `runTurn()` 之前调用**（判据在第一个 `await` 之前求值，见 `shouldAutoTitle`）。
 * 调用方通常不 await 它——命名是后台任务，不该让用户的这一轮多等一次网络往返。
 *
 * 返回最终标题；判据不成立、被取消、模型没说话、净化后为空，一律返回 `undefined`
 * 且**一条事件都不发**。命名失败的正确表现是"标题没变"，不是"标题变成空的"。
 */
export async function autoTitleSession(deps: AutoTitleDeps, text: string): Promise<string | undefined> {
  const { runtime, provider, model, signal } = deps;
  if (!shouldAutoTitle(runtime.state, text)) return undefined;

  const drained = await drainText(provider, buildTitleRequest(model, text), signal);
  // 取消时端口约定不发 usage、以 aborted 收尾——靠这个判，不靠文本长度猜
  if (drained.stopReason === 'aborted') return undefined;
  if (signal?.aborted === true) return undefined;

  const title = sanitizeTitle(drained.text);
  if (title === undefined) return undefined;

  await runtime.record({ type: 'session.renamed', payload: { title } });
  return title;
}
