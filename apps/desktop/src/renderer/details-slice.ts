import type { AnyEvent, CallId } from '@xm/contracts';
import type { CodeDispatchView } from '../shared/code-dispatch.js';
import { toDispatchView } from '../shared/code-dispatch.js';

/**
 * 右栏详情这一组（M3.5-d）：当前选中的调用 + Code Mode 子调用投影。
 *
 * 两者都不是会话状态。`selectedCallId` 是纯 UI 态，切会话即丢，不进事件流、
 * 不进 localStorage（点哪一行不改变任何一次判定）。`dispatches` 是
 * `tool.code.dispatch` 的投影：打开会话时主进程按类型过滤读一次，之后跟着
 * 事件增量，和卡片同一条路。`reduce()` 对这条事件只推进 lastSeq（ADR-0072），
 * 所以它不能住进 `SessionState`——住进去就等于给「中间值进模型请求」留了一个入口。
 */
export interface DetailsSlice {
  selectedCallId: CallId | undefined;
  dispatches: ReadonlyMap<CallId, CodeDispatchView>;
  readonly selectCall: (callId: CallId | undefined) => void;
}

export const createDetailsSlice = (
  set: (partial: Partial<DetailsSlice>) => void,
): DetailsSlice => ({
  selectedCallId: undefined,
  dispatches: new Map(),
  selectCall: (callId) => {
    set({ selectedCallId: callId });
  },
});

export const mergeDispatch = (
  dispatches: ReadonlyMap<CallId, CodeDispatchView>,
  event: AnyEvent,
): ReadonlyMap<CallId, CodeDispatchView> => {
  if (event.type !== 'tool.code.dispatch') return dispatches;
  const view = toDispatchView(event.payload);
  const next = new Map(dispatches);
  next.set(view.callId, view);
  return next;
};

export const emptyDetailsOnSwitch = (): Pick<DetailsSlice, 'selectedCallId' | 'dispatches'> => ({
  selectedCallId: undefined,
  dispatches: new Map(),
});
