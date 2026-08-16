import type { CallId } from '@xm/contracts';
import type { EditProposalState } from './session-state.js';

/**
 * 会话状态里两张**副表**的上界（ADR-0070）。
 *
 * 它们与 `messages` 不同：`messages` 是会话本身，长就是长；而这两张是**投影用的旁路索引**，
 * 单条却可能比产生它的那条消息大一个量级（一份 `EditProposal` 带着每个文件的完整 diff
 * 和每一处 `oldText`/`newText`）。它们过去只增不删，`context.compacted` 也不碰，
 * 于是整份跟着 `readSession` 过 IPC、整份进快照——与已经修过一次的 G4/G5 是同一个形状。
 *
 * **数据没有丢**：事件流仍是唯一真相，丢的只是投影里的驻留副本。将来要做"按需回填"，
 * 路是 M3-g 给 `EventStore.ReadOptions` 加的 `types` 过滤，不是把字段加回状态。
 */
export const PRESENTATION_LIMIT = 256;
export const EDIT_PROPOSAL_LIMIT = 64;

/**
 * 记一条展示事实，超上界时淘汰**最旧**的那条。
 *
 * 淘汰后 `projectResultCard()` 拿到的 `presentation` 是 `undefined`，走 ADR-0058
 * 已经规定好的降级路径（退成通用卡片）。那是既有行为，不是为这次改动新造的退路。
 *
 * 按插入顺序淘汰是确定性的，所以"从快照 + 尾部回放"与"全量回放"给出同一张表——
 * 这一点由 `tests/bounded-index.test.ts` 盯着，它是这次改动唯一可能引入静默不一致的地方。
 */
export function recordPresentation(
  presentations: ReadonlyMap<CallId, unknown>,
  callId: CallId,
  presentation: unknown,
): ReadonlyMap<CallId, unknown> {
  const next = new Map(presentations);
  next.delete(callId); // 重复写入要重新排到队尾，而不是留在原位
  next.set(callId, presentation);
  while (next.size > PRESENTATION_LIMIT) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

/** 提案是否已经走完了它的生命周期——应用过，或者审阅过但没应用。 */
const isTerminal = (item: EditProposalState): boolean =>
  item.appliedAt !== undefined || item.reviewedAt !== undefined;

/**
 * 追加一条编辑提案，超上界时**优先淘汰终态**的那些。
 *
 * 顺序是先按终态、再按新旧：终态提案只对"翻历史看那次改了什么"有用，
 * 而未应用的提案还等着被 `edit.apply` 引用。终态不够时才淘汰最旧的非终态——
 * 那种情况下模型堆了 64 条以上没人应用的提案，最旧的那条本来也已经过期了
 * （`beforeHash` 多半对不上）。
 *
 * 被淘汰的提案再被引用时，命中 `edit.apply` 里已有的"找不到当前会话中的编辑提案"分支：
 * **复用一条已经存在、已经测过的失败路径，不新增错误语义。**
 */
export function appendEditProposal(
  proposals: readonly EditProposalState[],
  next: EditProposalState,
): readonly EditProposalState[] {
  const kept = [
    ...proposals.filter((item) => item.proposal.proposalId !== next.proposal.proposalId),
    next,
  ];
  if (kept.length <= EDIT_PROPOSAL_LIMIT) return kept;

  const over = kept.length - EDIT_PROPOSAL_LIMIT;
  const evicted = new Set<number>();
  for (const [index, item] of kept.entries()) {
    if (evicted.size === over) break;
    if (isTerminal(item)) evicted.add(index);
  }
  for (const index of kept.keys()) {
    if (evicted.size === over) break;
    evicted.add(index); // 终态不够，只好从最旧的开始淘汰
  }
  return kept.filter((_item, index) => !evicted.has(index));
}
