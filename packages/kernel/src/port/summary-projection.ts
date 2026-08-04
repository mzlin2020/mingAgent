import type { PersistedEvent, SessionId } from '@xm/contracts';
import type { SessionSummary } from './event-store.js';

/**
 * 会话摘要投影的**唯一**推进规则。
 *
 * 放在内核而不是各个适配器里，理由和 `reduce` 一样：投影规则是逻辑，不是存储细节。
 * 一旦让 SQLite 适配器用 SQL 写一遍、内存实现用 TS 写一遍，两边就会慢慢分叉——
 * 而分叉的表现是"会话列表里的标题跟打开后看到的不一样"，属于用户会发现、
 * 开发者查不出来的那类问题。
 *
 * 适配器要做的只有一件事：在 `append` 的同一个事务里，把这个函数的结果写回摘要表。
 */
export const initialSummary = (sessionId: SessionId): SessionSummary => ({
  sessionId,
  createdAt: 0,
  updatedAt: 0,
  lastSeq: 0,
});

export function applyToSummary(prev: SessionSummary, e: PersistedEvent): SessionSummary {
  const base: SessionSummary = {
    ...prev,
    // createdAt 只在 session.created 上落定；此前为 0
    updatedAt: Math.max(prev.updatedAt, e.ts),
    lastSeq: e.seq,
  };

  switch (e.type) {
    case 'session.created':
      return {
        ...base,
        createdAt: e.ts,
        ...(e.payload.title === undefined ? {} : { title: e.payload.title }),
        ...(e.payload.parentSessionId === undefined
          ? {}
          : { parentSessionId: e.payload.parentSessionId }),
      };
    case 'session.renamed':
      return { ...base, title: e.payload.title };
    default:
      // 其余事件只推进时间与 seq。刻意不做穷尽性检查——摘要是**投影**，
      // 新增一种事件不该被迫在这里表态，那正是它与 reduce 的区别。
      return base;
  }
}

/** 从一整条事件流重建摘要。投影损坏、或摘要加了新字段时用。 */
export const buildSummary = (
  sessionId: SessionId,
  events: Iterable<PersistedEvent>,
): SessionSummary => {
  let s = initialSummary(sessionId);
  for (const e of events) s = applyToSummary(s, e);
  return s;
};
