import type { CallId, ErrorCode, ToolCallOrigin } from '@xm/contracts';
import { CARD_ACTION_PAYLOAD, xmError } from '@xm/contracts';
import type { RegisteredTool, ToolActionCall } from '@xm/kernel';
import { ScriptedProvider } from './provider/scripted.js';
import { NEVER_TURN_ABORTS } from './turn-events.js';
import { runTurn } from './turn.js';
import type { TurnDeps } from './turn-types.js';

/**
 * 卡片动作通道（ADR-0065）。
 *
 * 渲染层送上来的只有 `{ callId, actionId, payload }`——没有工具名、没有路径、
 * 没有任何"要执行什么"的描述。**说了算的是已落库的历史**：
 *
 *  ① 信封校验（在 IPC 边界做，不在这里）
 *  ② 由 `callId` 从**当前会话已 reduce 出来的状态**反查是哪个工具、当时的入参是什么
 *  ③ 按该工具声明的动作校验载荷；未声明的 `actionId` 直接拒绝（失败关闭）
 *  ④ 动作转化为一次**新的**工具调用，进完整十二步链
 *
 * 三条不继承（ADR-0065 §三），每条都对应一个已经踩过的坑：
 *  - **不复用原调用的判定结果。** `edit.preview` 被允许，不代表由它衍生的写入被允许。
 *  - **不因为"用户点的"就提升信任级别。** 被接受的内容仍然是模型产出的
 *    （diff 的每一行都来自模型），污点照常传播——这是 ADR-0045
 *    "diff 审阅不是权限审批"在新通道上的落点。
 *  - **不允许跨会话引用 `callId`。** 反查只在当前会话的状态里做，查不到就是拒绝。
 */

export interface CardActionRequest {
  readonly callId: CallId;
  readonly actionId: string;
  readonly payload: unknown;
}

export interface CardActionResult {
  /** 动作是否真的转成了一次工具调用。"拒绝全部"这类动作没有后续调用，也是成功 */
  readonly dispatched: boolean;
}

/** 拒绝理由带 code，好让 IPC 边界原样回给渲染层（不跨 IPC 抛异常） */
export class CardActionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CardActionError';
    this.code = code;
  }
}

export async function runCardAction(
  deps: TurnDeps,
  request: CardActionRequest,
): Promise<CardActionResult> {
  const origin = locateCall(deps, request.callId);
  const tool = deps.tools.get(origin.name);
  if (tool === undefined) {
    throw new CardActionError('tool_not_found', `工具 "${origin.name}" 已不在本机的工具表里。`);
  }
  const action = tool.actions[request.actionId];
  if (action === undefined) {
    throw new CardActionError(
      'unsupported',
      `工具 ${origin.name} 没有声明动作 "${request.actionId}"。`,
    );
  }
  const payload = CARD_ACTION_PAYLOAD[action.payload].safeParse(request.payload);
  if (!payload.success) {
    throw new CardActionError('invalid_input', `动作 "${request.actionId}" 的载荷不合法。`);
  }
  const input = tool.inputSchema.safeParse(origin.input);
  if (!input.success) {
    throw new CardActionError('invalid_input', '这次调用的历史入参已不合当前契约，无法据此动作。');
  }

  const call = await action.prepare({
    input: input.data,
    presentation: tool.parsePresentation(deps.runtime.state.presentations.get(request.callId)),
    payload: payload.data,
    ctx: {
      sessionId: deps.runtime.sessionId,
      cwd: deps.runtime.state.cwd,
      executor: deps.executor,
      signal: deps.signal ?? NEVER_TURN_ABORTS,
    },
  });
  if (call === undefined) return { dispatched: false };

  await dispatch(deps, tool, request, call);
  return { dispatched: true };
}

/**
 * ② 由 `callId` 反查工具与当时的入参。
 *
 * **只看 `reduce(events)` 出来的状态**，不看渲染层送上来的任何字段——
 * 这一条是选项 B 那个钓鱼面的封堵点：一张精心构造的卡片说了不算，说了算的是历史。
 * 跨会话的 `callId` 在这里天然查不到，因为查的是本会话的状态。
 */
function locateCall(
  deps: TurnDeps,
  callId: CallId,
): { readonly name: string; readonly input: unknown } {
  for (const message of deps.runtime.state.messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.id === callId) {
        return { name: block.name, input: block.input };
      }
    }
  }
  throw new CardActionError('tool_not_found', '这次调用不属于当前会话。');
}

/**
 * ④ 转化为一次新的工具调用，进完整十二步链。
 *
 * 走的是与模型调用**完全同一条**路径（`runTurn` + 一个只念这一次调用的 Provider），
 * 而不是"直接执行工具"的近路——网关规范化、红线判定、分层求值、checkpoint、
 * 截断、审计，一样都不少。`callOrigins` 是唯一的区别，它只影响事件流里记的
 * "谁按的"，不影响任何判定。
 */
async function dispatch(
  deps: TurnDeps,
  tool: RegisteredTool,
  request: CardActionRequest,
  call: ToolActionCall,
): Promise<void> {
  const callId = deps.runtime.ids.call();
  const origin: ToolCallOrigin = {
    kind: 'user-action',
    fromCallId: request.callId,
    actionId: request.actionId,
  };
  const provider = new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'tool_call_start', id: callId, name: call.name },
          { kind: 'tool_call_delta', id: callId, argsJson: JSON.stringify(call.args) },
          { kind: 'tool_call_end', id: callId },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
    ],
  });
  const label = tool.actions[request.actionId]?.label ?? request.actionId;
  await runTurn(
    {
      ...deps,
      provider,
      model: 'scripted-1',
      callOrigins: new Map([[callId, origin]]),
    },
    [{ type: 'text', text: `用户在卡片上点了「${label}」。` }],
  );
}

export const cardActionErrorOf = (error: unknown): ReturnType<typeof xmError> =>
  error instanceof CardActionError
    ? xmError(error.code, error.message)
    : xmError('internal', error instanceof Error ? error.message : String(error));
