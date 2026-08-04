import type { XmEvent } from '@xm/contracts';

/**
 * `seq` 不变量校验（docs/10 §4.1）。
 *
 * 会话内的 seq 必须从 1 开始、单调递增、**无空洞**。三条各有各的用处：
 *   · 从 1 开始 —— 空会话与"第一条事件丢了"可区分
 *   · 单调递增 —— 存储层 `PRIMARY KEY(session_id, seq)` 才能当并发写检测用
 *   · 无空洞   —— "从 seq N 起增量订阅"无需任何额外元数据。UI 重连、CLI attach、
 *                 评测回放全靠它
 *
 * 违反不变量属于必须立刻暴露的严重问题（多半意味着有第二个写者），
 * **不做重试、不做修复**——静默补洞会把一次并发写事故变成一段永远查不清的历史。
 */
export class SeqInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeqInvariantError';
  }
}

/**
 * 校验一段**持久化**事件流的 seq。瞬态事件不占 seq 空间，传进来会误报，
 * 所以调用前请先按 durability 过滤。
 */
export function assertSeqContiguous(events: readonly XmEvent[], startFrom = 1): void {
  let expected = startFrom;
  for (const e of events) {
    if (e.seq !== expected) {
      throw new SeqInvariantError(
        e.seq < expected
          ? `seq 回退或重复：期望 ${String(expected)}，实际 ${String(e.seq)}（事件 ${e.type}）。` +
            `这通常意味着同一会话存在第二个写者。`
          : `seq 出现空洞：期望 ${String(expected)}，实际 ${String(e.seq)}（事件 ${e.type}）。` +
            `瞬态事件不应占用 seq；若这里传入了瞬态事件，请先过滤。`,
      );
    }
    expected += 1;
  }
}

/** 下一个可用的 seq。写入侧唯一的分配入口。 */
export const nextSeq = (lastSeq: number): number => lastSeq + 1;
