import type { CallId, MessageId, RequestId, TurnId } from '@xm/contracts';
import type { RunningCall, SessionState } from './session-state.js';

/** 一个从没走到 `tool.start` 的调用——批里排在"卡住的那个"后面，压根没轮到它。 */
export interface DanglingToolUse {
  readonly callId: CallId;
  readonly name: string;
  readonly input: unknown;
}

/**
 * 一个"没配对"的回合——进程在这个回合跑到一半时被杀掉，重启后重放事件流会停在这里。
 *
 * 崩溃恢复要能区分四种停法，因为每一种收尾时要补发的事件不一样（见 `crash-recovery.ts`
 * 的 `synthesizeInterruption`）：
 *
 *   · `'message'`    模型正在流式输出，`message.end`/`message.interrupted` 还没写
 *   · `'tool'`        至少一个工具调用只有 `tool.start`，没有 `tool.end`
 *   · `'permission'`  正等用户批一个权限请求，`permission.decision` 还没写
 *   · `'none'`        `turn.start` 已落库，但恰好停在一次迭代边界上——没有更具体的东西挂着
 *
 * 判定顺序对应真实的时间顺序（一条消息里可能带着待处理的工具调用，但工具调用不会
 * 反过来带着一条"正在流"的消息），所以这四种互斥，`if` 链就是完整的判定逻辑。
 *
 * ── `danglingToolUses`：一个批里排在后面、压根没轮到的调用 ──
 *
 * `runTurn()` 对一批并行 `tool_use` 是**顺序** `dispatchCall`（turn.ts）：一条消息可以带
 * 好几个 `tool_use` 块，若崩溃发生在处理第 2 个（正在执行、或正等权限审批）时，第 3 个
 * 及之后的调用连 `permission.request` 都没发过——它们在 `messages` 里的 `tool_use` 块
 * 没有任何配对的 `tool_result`，且不会出现在 `runningCalls`/`pendingPermission` 里
 * （那两个字段只认"已经被 dispatchCall 碰过"的调用）。这类调用如果不补一个 `tool.end`，
 * 续跑时喂给模型的上一条 assistant 消息里会有 `tool_use` 找不到匹配的 `tool_result`，
 * 这在 Anthropic 的 Messages API 里是硬错误，会让"继续"这条路直接失败。
 *
 * 只有 `'tool'`/`'permission'` 这两种停法可能有这类调用：`'message'` 时上一批
 * （如果有）已经在 `dispatchCall` 的 `for` 循环里跑完才会轮到新一条消息开始流式输出，
 * 不会有遗留；`'none'` 同理。
 */
export type OrphanedTurn =
  | { readonly turnId: TurnId; readonly kind: 'message'; readonly messageId: MessageId }
  | {
      readonly turnId: TurnId;
      readonly kind: 'tool';
      readonly calls: readonly RunningCall[];
      readonly danglingToolUses: readonly DanglingToolUse[];
    }
  | {
      readonly turnId: TurnId;
      readonly kind: 'permission';
      readonly requestId: RequestId;
      readonly callId: CallId | undefined;
      readonly danglingToolUses: readonly DanglingToolUse[];
    }
  | { readonly turnId: TurnId; readonly kind: 'none' };

/**
 * 纯函数：给定回放到底的会话状态，判断它是不是停在了一个没收尾的回合里。
 *
 * **这不是 `reduce()` 的一部分**，也刻意不放进 `deriveTraces()`（trace/derive-trace.ts）。
 * `reduce()` 必须对它声明过的整个事件词表保持"全"——同一段事件流，被仍然活着的进程
 * 回放是"确实还在跑"，被重启后的新进程回放是"孤儿"，这个区别来自事件流之外的上下文
 * （谁在问、什么时候问），`reduce()` 结构上不可能知道。`deriveTraces()` 是只读的观测投影，
 * "猜不出就标 unknown"是它的正确姿态；崩溃恢复要驱动真实动作（合成收尾事件、决定继续
 * 还是放弃），需要 `RunningCall.input`/`messageId`、`pendingPermission.requestId` 这类
 * trace 不携带的结构化细节。两者恰好都在识别"没配对的 turn.start"，但服务不同消费者。
 */
export function detectOrphanedTurn(state: SessionState): OrphanedTurn | undefined {
  if (state.activeTurn === undefined) return undefined;
  const turnId = state.activeTurn.turnId;

  if (state.activeMessage !== undefined) {
    return { turnId, kind: 'message', messageId: state.activeMessage.messageId };
  }
  if (state.runningCalls.size > 0) {
    return { turnId, kind: 'tool', calls: [...state.runningCalls.values()], danglingToolUses: danglingOf(state) };
  }
  if (state.pendingPermission !== undefined) {
    return {
      turnId,
      kind: 'permission',
      requestId: state.pendingPermission.requestId,
      callId: state.pendingPermission.callId,
      danglingToolUses: danglingOf(state),
    };
  }
  return { turnId, kind: 'none' };
}

/**
 * 最后一条 assistant 消息里，`tool_use` 块没有配对 `tool_result`、且不在 `runningCalls`
 * 里的那些——即"批里没轮到的调用"（见上面 `danglingToolUses` 的注释）。
 */
function danglingOf(state: SessionState): readonly DanglingToolUse[] {
  const lastAssistantIdx = [...state.messages].reverse().findIndex((m) => m.role === 'assistant');
  if (lastAssistantIdx === -1) return [];
  const assistant = state.messages.at(state.messages.length - 1 - lastAssistantIdx);
  if (assistant === undefined) return [];

  const resolvedIds = new Set<string>();
  for (const m of state.messages.slice(state.messages.length - lastAssistantIdx)) {
    for (const b of m.blocks) {
      if (b.type === 'tool_result') resolvedIds.add(b.toolUseId);
    }
  }

  const dangling: DanglingToolUse[] = [];
  for (const b of assistant.blocks) {
    if (b.type !== 'tool_use') continue;
    if (resolvedIds.has(b.id)) continue;
    // 已经在 runningCalls / pendingPermission 里的那一个是"卡住的那个"本身，
    // 由 kind === 'tool' / 'permission' 各自的主字段承载，不算"没轮到"
    if (state.runningCalls.has(b.id)) continue;
    if (state.pendingPermission?.callId === b.id) continue;
    dangling.push({ callId: b.id, name: b.name, input: b.input });
  }
  return dangling;
}
