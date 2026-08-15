import type { AnyEvent, CallId, SessionId, ToolCardPair } from '@xm/contracts';
import { api } from './bridge.js';

/**
 * 工具卡片这一组状态与动作（ADR-0058 / ADR-0065），从 `store.ts` 里拆出来。
 *
 * ── 为什么它是一个独立的 slice ──
 *
 * 卡片**不是**会话状态的一部分：`session` 是 `reduce(events)` 的结果，
 * 而卡片是主进程按工具自己的投影函数算出来、随事件一起送过来的一份**纯函数投影**
 * （投影函数含在工具定义里、跨不了进程，见 `kernel/tool/present.ts`）。
 *
 * 它因此不构成 ADR-0015 要防的"第二份会漂移的状态"：它没有自己的生命周期，
 * 打开会话时整份替换、之后只跟着事件增量、切会话即清空，换个进程重算一遍必然一模一样。
 * 但它也确实不属于 `SessionState`，所以放在这里，而不是硬塞进那份镜像。
 */

export interface CardsSlice {
  /** 每次工具调用的挂起/完成卡片，按 `callId` 索引 */
  cards: ReadonlyMap<CallId, ToolCardPair>;
  /**
   * 点了卡片上的一个动作。渲染层能说的只有"哪次调用、哪个动作、一份闭集内的载荷"——
   * 它不知道点下去会调用什么工具，这正是这条通道能开的前提（ADR-0065）。
   *
   * **不乐观更新**：动作会不会真的变成一次写入，由主进程那边的完整闸门链决定，
   * 结果通过事件流回来。抢先在 UI 上显示"已应用"就是在权限相关的界面上撒谎。
   */
  readonly cardAction: (
    callId: CallId,
    actionId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}

export const createCardsSlice = (
  set: (partial: Partial<CardsSlice>) => void,
  get: () => CardsSlice & { readonly currentId: SessionId | undefined },
  onError: (error: unknown, sessionId?: SessionId) => void,
): CardsSlice => ({
  cards: new Map(),
  cardAction: async (callId, actionId, payload) => {
    const sessionId = get().currentId;
    if (sessionId === undefined) return;
    try {
      await api.cardAction(sessionId, callId, actionId, payload);
    } catch (error) {
      onError(error, sessionId);
    }
  },
});

/** 卡片随事件同行，只补这一次调用的那一半（挂起或完成） */
export const mergeCard = (
  cards: ReadonlyMap<CallId, ToolCardPair>,
  event: AnyEvent,
  card: ToolCardPair | undefined,
): ReadonlyMap<CallId, ToolCardPair> => {
  if (card === undefined) return cards;
  if (event.type !== 'tool.start' && event.type !== 'tool.end') return cards;
  const callId = (event.payload as { readonly callId: CallId }).callId;
  const next = new Map(cards);
  next.set(callId, { ...next.get(callId), ...card });
  return next;
};
