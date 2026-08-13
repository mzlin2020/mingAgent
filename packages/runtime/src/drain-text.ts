import type { ModelRequest, StopReason, Usage } from '@xm/contracts';
import type { AbortLike, ModelProvider } from '@xm/kernel';

/**
 * 把一次流式调用抽干成一个完整字符串。
 *
 * ── 这个文件为什么必须存在，而不是给端口加 `complete()` ──
 *
 * `packages/kernel/src/port/model-provider.ts` 顶部的禁令是硬的：
 *
 * > **一、只有流式。** 不提供 `complete()`。非流式接口一旦存在，就一定会有调用点
 * > 图省事用它，而"用户点停止要在 200ms 内真停"（docs/04 §7）在非流式路径上做不到。
 *
 * 但确实存在"我只要最终那段文字"的调用方（ADR-0038 的会话自动命名与
 * ADR-0048 的上下文摘要）。docs/01 原则五给的答案是**由上层聚合**——
 * 这个文件就是那个"上层"。聚合放在这里而不是端口里，区别不是风格：
 * 取消信号照样一路传到底层 fetch，`stopReason` 照样如实回报，
 * 200ms 真停这条不变量不因为"调用方只想要字符串"而被绕过。
 *
 * 谁要是又想在端口上加 `complete()`，先读完上面那段。
 */

/** 永不触发的取消信号。给"确实没有取消源"的调用方，好过让 `signal` 变成可选 */
export const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export interface DrainedText {
  /**
   * 只拼 `text_delta`。`thinking_delta` 与工具调用一律丢弃——思考过程不是回答，
   * 而会用到本函数的调用方（取标题、做摘要）要的都是"最终那段文字"。
   */
  readonly text: string;
  /**
   * **必须看**。端口约定取消时正常结束迭代、以 `{ kind: 'stop', reason: 'aborted' }`
   * 收尾且**不发 usage**，所以 `text === ''` 分不出"模型什么都没说"和"被取消了"。
   * 靠这个字段判，不要靠文本长度猜。
   */
  readonly stopReason: StopReason;
  /** 中断时端口约定不发 usage，此时为 `undefined`——"不知道"不能写成"是零" */
  readonly usage: Usage | undefined;
}

export async function drainText(
  provider: ModelProvider,
  req: ModelRequest,
  signal: AbortLike = NEVER_ABORTS,
): Promise<DrainedText> {
  const parts: string[] = [];
  // 流没给 stop 就结束（实现不合规）时，'error' 比默认成 'end_turn' 诚实
  let stopReason: StopReason = 'error';
  let usage: Usage | undefined;

  for await (const chunk of provider.stream(req, signal)) {
    if (chunk.kind === 'text_delta') parts.push(chunk.text);
    else if (chunk.kind === 'usage') usage = chunk.usage;
    else if (chunk.kind === 'stop') stopReason = chunk.reason;
  }

  return { text: parts.join(''), stopReason, usage };
}
