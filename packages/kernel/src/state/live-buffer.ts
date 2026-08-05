import type { MessageId, XmEvent } from '@xm/contracts';

/**
 * 在途消息缓冲 —— **不是** `SessionState` 的一部分（ADR-0021）。
 *
 * ── 它为什么必须存在 ──
 *
 * 两条各自完全正确的约束，合起来产生了一个洞（docs/09 G6）：
 *
 *   · ADR-0008：瞬态事件（`message.delta`）在 `reduce` 里**必须是空操作**，
 *              不得改变状态的任何一位。
 *   · ADR-0015：渲染层**不持有第二份状态**，消息流全部由 `reduce()` 算出。
 *
 * 于是 `message.delta` 到达时，UI 什么也不做——**模型正在输出的文字，在 `message.end`
 * 落库之前一个字都不会显示**。M0-b 看不出来，因为脚本化 Provider 是瞬间返回的；
 * 接上真实模型，一次三十秒的回复期间界面完全静止，而那恰恰是对话类产品最核心的体感。
 *
 * ── 它凭什么不违反 ADR-0015 ──
 *
 * ADR-0015 禁的是「UI 自己维护一份**会和回放结果分叉**的 messages」。分叉之所以致命，
 * 是因为它的表现是"刷新一下内容就变了"，而且没人能说清哪一份是对的。
 *
 * 这里渲染的是**尚未持久化的在途事件**：它本来就不在回放结果里，`message.end` 一到
 * 就归零。两者在时间上互斥——**任何时刻，同一段文字要么在 buffer 里，要么在
 * `state.messages` 里，不会同时在两边**。没有重叠，就没有分叉的余地。
 *
 * 这条互斥是可执行的判据，不是一句辩解：`tests/live-buffer.test.ts` 把它变成用例。
 *
 * ── 它为什么在内核而不在渲染层 ──
 *
 * CLI（M3）要渲染同一件事。把它写在 `store.ts` 里，CLI 就会再写一份，
 * 两份的清零时机会慢慢分叉——那时"什么时候归零"就变成了两个答案。
 * 而且它是纯函数，放在内核才能被穷举测试。
 */
export interface LiveBuffer {
  readonly messageId: MessageId;
  /** 已到达的正文增量拼接 */
  readonly text: string;
  /** 已到达的思考增量拼接 */
  readonly thinking: string;
}

export const emptyLiveBuffer = (): LiveBuffer | undefined => undefined;

/**
 * 把一条事件叠进在途缓冲。**归零的时机是这个函数的全部要害。**
 *
 * 四种归零：
 *   · `message.end`         —— 正文已经进了 `state.messages`，再留着就是重影
 *   · `message.interrupted` —— 用户按了停止，在途内容不该继续挂在屏幕上
 *   · `turn.end`            —— 兜底。回合结束却还有在途消息，说明前两条漏了一条，
 *                              这时宁可少显示，也不要留下一段永远不会被替换的文字
 *   · `message.start`       —— 新消息开始，旧的必须让位（同时也是新缓冲的起点）
 *
 * 漏掉任何一条的后果都一样：屏幕上出现一段**回放不出来**的文字，
 * 而那正是 ADR-0015 要防的那种"第二份状态"。
 */
export function applyLive(buffer: LiveBuffer | undefined, e: XmEvent): LiveBuffer | undefined {
  switch (e.type) {
    case 'message.start':
      // assistant 之外的角色不会流式输出，不给它开缓冲
      return e.payload.role === 'assistant'
        ? { messageId: e.payload.messageId, text: '', thinking: '' }
        : undefined;

    case 'message.delta': {
      // 没有 start 就来的 delta 一律丢弃：它属于某条我们没看见开头的消息，
      // 显示出来会挂在错误的位置上。订阅是可以中途接上的（fromSeq 续读），
      // 所以"没看见开头"是正常情况，不是错误。
      if (buffer?.messageId !== e.payload.messageId) return buffer;
      return e.payload.kind === 'thinking'
        ? { ...buffer, thinking: buffer.thinking + e.payload.text }
        : { ...buffer, text: buffer.text + e.payload.text };
    }

    case 'message.end':
    case 'message.interrupted':
    case 'turn.end':
      return undefined;

    default:
      return buffer;
  }
}
