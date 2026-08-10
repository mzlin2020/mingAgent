import type { SessionId } from '@xm/contracts';
import type { ListOrphanedSessionsResult } from '../shared/ipc.js';
import { api } from './bridge.js';

/**
 * 崩溃恢复这一组状态与动作（M1-e，docs/04 §8），从 `store.ts` 里拆出来。
 *
 * 拆分的理由不是"store.ts 太长了要挑一块搬走"——是这组东西本来就**不属于任何一个
 * 会话**：`orphanedSessions` 是启动时扫出来的、跨会话的一张列表，横幅因此挂在渲染层
 * 顶层，而不像 `TurnErrorBanner` 那样只在打开某个会话时才出现。它既不进事件流、也不
 * 随 `openSession` 切换，与 store 里其余字段（`session`/`live`/`approvalMode` 全都以
 * "当前会话"为轴）没有共享的不变量，唯一的耦合是共用同一个 `applyIpcError` 出错收口。
 *
 * 拆成 zustand 的 slice 而不是独立的 store：横幅需要同时读 `currentId` 才能判断
 * "崩溃的是不是正开着的这个会话"（见 banners.tsx），分成两个 store 就得让组件自己
 * 跨 store 对齐，那才是把一件事拆成两处。
 */
export interface OrphanedSlice {
  /**
   * 启动时扫描出的、停在没收尾回合里的会话。
   * 跟 `status` 一样不是任何一个会话状态的一部分，回放也回放不出来。
   */
  orphanedSessions: ListOrphanedSessionsResult;
  readonly refreshOrphanedSessions: () => Promise<void>;
  /** 继续：从崩溃发生的那个迭代边界续跑。若那时正打开着这个会话，事件会经总线自然刷新界面 */
  readonly resumeOrphaned: (sessionId: SessionId) => Promise<void>;
  /** 放弃：写 turn.end(reason:'aborted')，语义与停止按钮相同 */
  readonly abandonOrphaned: (sessionId: SessionId) => Promise<void>;
}

/**
 * `applyIpcError` 由 store 注入：出错该往哪个状态字段写是整个渲染层统一的一条规则
 * （见 `ipc-error.ts`），不该在这里再实现一遍。
 */
export function createOrphanedSlice(
  set: (partial: Partial<OrphanedSlice>) => void,
  get: () => OrphanedSlice,
  applyIpcError: (e: unknown, sessionId?: SessionId) => void,
): OrphanedSlice {
  /**
   * 继续/放弃都不乐观更新状态本身——与 `stop` 同一个姿态。
   * 唯一在这里做的乐观更新是把这一条从列表里摘掉：调用回来说明扫描时的旧缓存已经过期
   * （多半是已经被处理过一次），显示一条僵尸行没有意义。
   * 若这个会话此刻正打开着，真正的状态变化经总线推来的事件走 `applyEvent`，
   * 跟"停止"按钮完全一样，不需要在这里另外拉一次。
   */
  const drop = (sessionId: SessionId): void => {
    set({ orphanedSessions: get().orphanedSessions.filter((o) => o.sessionId !== sessionId) });
  };

  return {
    orphanedSessions: [],

    refreshOrphanedSessions: async () => {
      try {
        set({ orphanedSessions: await api.listOrphanedSessions() });
      } catch (e) {
        applyIpcError(e);
      }
    },

    resumeOrphaned: async (sessionId) => {
      try {
        await api.resumeOrphanedSession(sessionId);
      } catch (e) {
        applyIpcError(e, sessionId);
      } finally {
        drop(sessionId);
      }
    },

    abandonOrphaned: async (sessionId) => {
      try {
        await api.abandonOrphanedSession(sessionId);
      } catch (e) {
        applyIpcError(e, sessionId);
      } finally {
        drop(sessionId);
      }
    },
  };
}
