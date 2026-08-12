import type { CallId, MessageId, PtySessionId, XmEvent } from '@xm/contracts';

/**
 * 在途缓冲 —— **不是** `SessionState` 的一部分（ADR-0021）。
 *
 * ── 它为什么必须存在 ──
 *
 * 两条各自完全正确的约束，合起来产生了一个洞（docs/09 G6）：
 *
 *   · ADR-0008：瞬态事件（`message.delta` / `provider.status` / `tool.progress`）在 `reduce` 里**必须是
 *              空操作**，不得改变状态的任何一位。
 *   · ADR-0015：渲染层**不持有第二份状态**，消息流全部由 `reduce()` 算出。
 *
 * 于是瞬态事件到达时，UI 什么也不做——**模型正在输出的文字，在 `message.end`
 * 落库之前一个字都不会显示**；工具跑到第几步，同样显示不出来。M0-b 看不出来，
 * 因为脚本化 Provider 是瞬间返回的；接上真实模型与真实工具，一次三十秒的回复
 * 或一次读几千个文件的调用期间界面完全静止，而那恰恰是最需要反馈的时刻。
 *
 * ── 它凭什么不违反 ADR-0015 ──
 *
 * ADR-0015 禁的是「UI 自己维护一份**会和回放结果分叉**的状态」。分叉之所以致命，
 * 是因为它的表现是"刷新一下内容就变了"，而且没人能说清哪一份是对的。
 *
 * 这里渲染的是**尚未持久化的在途事件**，判据是：
 *
 *   **任何时刻，同一条信息要么在 buffer 里，要么在 `state` 里，不会同时在两边。**
 *
 * 两个部分满足这条判据的方式**不一样**，这个区别要说清楚：
 *
 *   · `message`：delta 里的文字最终会**原样进** `message.end`，所以它是"先在 buffer、
 *     后在 state"，靠 `message.end` 的归零完成交接。
 *   · `calls`：`tool.progress` 的内容**永远不会进** state（它是纯瞬态的进度描述，
 *     持久流里对应的是 `tool.end` 的结果）。所以它的判据是"随 `tool.end` 消失"——
 *     不是被取代，是本来就不该留下。
 *
 * 漏掉任何一条归零的后果都一样：屏幕上出现一段**回放不出来**的内容，
 * 而那正是 ADR-0015 要防的那种"第二份状态"。
 *
 * ── 它为什么在内核而不在渲染层 ──
 *
 * CLI（M3）要渲染同一件事。把它写在 `store.ts` 里，CLI 就会再写一份，
 * 两份的清零时机会慢慢分叉——那时"什么时候归零"就变成了两个答案。
 * 而且它是纯函数，放在内核才能被穷举测试。
 */
export interface LiveBuffer {
  /** 正在流式输出的那条消息。没有则为 undefined */
  readonly message: LiveMessage | undefined;
  /** 正在跑的工具调用 → 它最新一条进度。`tool.end` 到达即删除 */
  readonly calls: ReadonlyMap<CallId, LiveCall>;
  /**
   * 打开过的 PTY 会话（ADR-0031）→ 累积输出文本。**跨 turn 存活**——这是它与
   * `message`/`calls` 唯一的形状差异：后两者的判据是"随本轮的结束事件归零"，
   * 而 PTY 会话本来就是"打开一次、跨越多个 turn 持续存在"的东西，`turn.end`
   * 不该把它冲掉，只有 `shell.session.closed` 才该把它标记为已结束。
   *
   * 全量文本、不截断——这是纯前端展示缓冲，不落库、不进 `SessionState`，
   * 关掉面板或应用重启就没了，与 ADR-0031"只有回放尾巴 `tail` 落库"是同一件事
   * 在两处的体现：完整实时内容只值一次性展示，不值得持久化。
   */
  readonly terminals: ReadonlyMap<PtySessionId, LiveTerminal>;
}

export interface LiveTerminal {
  readonly ptySessionId: PtySessionId;
  readonly cwd: string;
  readonly text: string;
  readonly closed: boolean;
}

export interface LiveMessage {
  readonly messageId: MessageId;
  /** 已到达的正文增量拼接 */
  readonly text: string;
  /** 已到达的思考增量拼接 */
  readonly thinking: string;
  /** Provider 自动重试的瞬态状态；收到首字节或任意内容增量后清除。 */
  readonly providerStatus: LiveProviderStatus | undefined;
}

export interface LiveProviderStatus {
  readonly phase: 'retrying';
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface LiveCall {
  readonly callId: CallId;
  /**
   * 最新一条进度描述。**只留最新的一条，不做历史堆叠**——
   * 进度是"现在在干什么"，堆起来就成了日志，而日志属于 `tool.end` 的结果。
   */
  readonly message: string;
  /** 工具附带的结构化进度数据（如已处理文件数），原样透传给 UI */
  readonly data: unknown;
}

export const EMPTY_LIVE: LiveBuffer = { message: undefined, calls: new Map(), terminals: new Map() };

/**
 * 把一条事件叠进在途缓冲。**归零的时机是这个函数的全部要害。**
 *
 * 消息部分的四种归零：
 *   · `message.end`         —— 正文已经进了 `state.messages`，再留着就是重影
 *   · `message.interrupted` —— 用户按了停止，在途内容不该继续挂在屏幕上
 *   · `turn.end`            —— 兜底。回合结束却还有在途内容，说明前两条漏了一条，
 *                              这时宁可少显示，也不要留下一段永远不会被替换的文字
 *   · `message.start`       —— 新消息开始，旧的必须让位（同时也是新缓冲的起点）
 *
 * 工具部分的两种归零：
 *   · `tool.end`  —— 这次调用的结果已经进了 `state.messages`
 *   · `turn.end`  —— 同样是兜底：回合结束了就不该再有"正在跑"的东西
 */
export function applyLive(buffer: LiveBuffer, e: XmEvent): LiveBuffer {
  switch (e.type) {
    case 'message.start':
      // assistant 之外的角色不会流式输出，不给它开缓冲
      return {
        ...buffer,
        message:
          e.payload.role === 'assistant'
            ? { messageId: e.payload.messageId, text: '', thinking: '', providerStatus: undefined }
            : undefined,
      };

    case 'provider.status': {
      const m = buffer.message;
      if (m === undefined) return buffer;
      if (e.payload.phase === 'connected') {
        return { ...buffer, message: { ...m, providerStatus: undefined } };
      }
      return {
        ...buffer,
        message: {
          ...m,
          providerStatus: {
            phase: 'retrying',
            attempt: e.payload.attempt ?? 1,
            maxAttempts: e.payload.maxAttempts ?? 1,
            delayMs: e.payload.delayMs ?? 0,
            reason: e.payload.reason ?? '连接失败',
          },
        },
      };
    }

    case 'message.delta': {
      // 没有 start 就来的 delta 一律丢弃：它属于某条我们没看见开头的消息，
      // 显示出来会挂在错误的位置上。订阅是可以中途接上的（fromSeq 续读），
      // 所以"没看见开头"是正常情况，不是错误。
      const m = buffer.message;
      if (m?.messageId !== e.payload.messageId) return buffer;
      return {
        ...buffer,
        message:
          e.payload.kind === 'thinking'
            ? { ...m, thinking: m.thinking + e.payload.text, providerStatus: undefined }
            : { ...m, text: m.text + e.payload.text, providerStatus: undefined },
      };
    }

    case 'message.end':
    case 'message.interrupted':
      return { ...buffer, message: undefined };

    case 'tool.progress': {
      const calls = new Map(buffer.calls);
      calls.set(e.payload.callId, {
        callId: e.payload.callId,
        message: e.payload.message ?? '',
        data: e.payload.data,
      });
      return { ...buffer, calls };
    }

    case 'tool.end': {
      if (!buffer.calls.has(e.payload.callId)) return buffer;
      const calls = new Map(buffer.calls);
      calls.delete(e.payload.callId);
      return { ...buffer, calls };
    }

    case 'turn.end':
      // terminals 特意不清——PTY 会话跨 turn 存活，见字段注释
      return { ...EMPTY_LIVE, terminals: buffer.terminals };

    case 'shell.session.opened': {
      const terminals = new Map(buffer.terminals);
      terminals.set(e.payload.ptySessionId, {
        ptySessionId: e.payload.ptySessionId,
        cwd: e.payload.cwd,
        text: '',
        closed: false,
      });
      return { ...buffer, terminals };
    }

    case 'shell.session.output': {
      const t = buffer.terminals.get(e.payload.ptySessionId);
      // 没看见 opened 就来的 output：与 message.delta 同一个宽容度，订阅可能中途接上
      if (t === undefined) return buffer;
      const terminals = new Map(buffer.terminals);
      terminals.set(e.payload.ptySessionId, { ...t, text: t.text + e.payload.chunk });
      return { ...buffer, terminals };
    }

    case 'shell.session.closed': {
      const t = buffer.terminals.get(e.payload.ptySessionId);
      if (t === undefined) return buffer;
      const terminals = new Map(buffer.terminals);
      const text = t.text === '' ? e.payload.tail : t.text;
      if (text === '') terminals.delete(e.payload.ptySessionId);
      else terminals.set(e.payload.ptySessionId, { ...t, text, closed: true });
      return { ...buffer, terminals };
    }

    default:
      return buffer;
  }
}

/** 缓冲里有没有值得显示的东西。UI 用它决定要不要渲染在途区域 */
export const hasLive = (buffer: LiveBuffer): boolean =>
  buffer.calls.size > 0 ||
  buffer.message !== undefined;
