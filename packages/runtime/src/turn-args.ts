/**
 * 工具调用入参的解码（地基复审四 C1）。
 *
 * ── 为什么这值得一个单独的文件 ──
 *
 * 这段逻辑此前在三个地方各写了一份，三份都是同一个形状：
 *
 * ```ts
 * try { return JSON.parse(argsJson); } catch { return {}; }
 * ```
 *
 * `argsJson` 是**模型输出**，也就是不可信输入（不变量三）。把它解不开这件事
 * 兑现成"一个空对象"，等于把"模型给了一段坏 JSON"翻译成"模型什么参数都没给"，
 * 而这两件事的后果完全不同：
 *
 * · 入参**全可选**的工具（`fs.list`、`git.status`、`todo.write`…）会**照常执行**，
 *   带着一整套默认值。模型以为自己让它读 `/a/b`，它读的是 cwd。
 * · 入参有必填字段的工具会报"缺少字段 x"，而真正的原因是"你那段 JSON 断在半路"——
 *   模型据此去补字段，补的是一个它本来就给了的字段，于是**同一个错反复重试**。
 * · 事件流里没有任何痕迹说 JSON 坏过。
 *
 * 最常见的成因不是模型犯傻，而是**流被截断**：`max_tokens` 恰好落在一次工具调用的
 * 参数中间，`argsJson` 就是一段合法 JSON 的前缀。
 *
 * 所以这里只做一件事：**把"解不开"如实说出来**，由调用方决定怎么处置。
 *
 * 空串是唯一的例外，而且它不是兜底：多数 Provider 对"零参数工具"发的就是空串
 * （或者干脆不发 `arguments`），那时 `{}` 是它字面上的意思。
 */

export type ParsedToolArgs =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** 出错信息里带多长的原文。够看出断在哪，又不至于把一整段脏数据塞进事件流 */
const EXCERPT_CHARS = 200;

export function parseToolArgs(argsJson: string): ParsedToolArgs {
  if (argsJson.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(argsJson) as unknown };
  } catch (error) {
    return {
      ok: false,
      message:
        `工具入参不是合法的 JSON（${error instanceof Error ? error.message : String(error)}）。` +
        `这次调用没有执行——常见原因是回复在参数中途被 max_tokens 截断，` +
        `请把整段参数重新发一次。收到的原文（前 ${String(EXCERPT_CHARS)} 字）：` +
        excerpt(argsJson),
    };
  }
}

function excerpt(raw: string): string {
  return raw.length <= EXCERPT_CHARS ? raw : `${raw.slice(0, EXCERPT_CHARS)}…（共 ${String(raw.length)} 字）`;
}
