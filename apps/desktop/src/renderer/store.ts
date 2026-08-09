import { create } from 'zustand';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { isCoreEvent, parseStoredEvent } from '@xm/contracts';
import type { LiveBuffer, SerializedSessionState, SessionState } from '@xm/kernel';
import { EMPTY_LIVE, applyLive, deserializeSessionState, reduce } from '@xm/kernel';
import type {
  ApprovalMode,
  ImageAttachment,
  ListOrphanedSessionsResult,
  ListSessionsResult,
  PushedEvent,
  StatusResult,
} from '../shared/ipc.js';
import type { z } from 'zod';
import { api } from './bridge.js';
import { classifyIpcError } from './ipc-error.js';

type Status = z.infer<typeof StatusResult>;

/**
 * 渲染层状态。
 *
 * ── 会话状态由 `reduce()` 算出，UI 不维护第二份真相（ADR-0015）──
 *
 * 消息列表、运行中的工具、待审批的权限……全都从事件流 reduce 出来，跟主进程用的是
 * **同一个纯函数**。这不是复用代码的小便宜，它是"会话状态 = reduce(events)"这条
 * 原则在 UI 上唯一成立的方式：只要 UI 自己维护一份 messages 数组，
 * 它就会和回放出来的那份慢慢分叉，而分叉的表现是刷新一下内容就变了。
 *
 * **每一条新事件仍然在这里过 `reduce()`**（见下面的 `applyEvent`）——这仍然是
 * 「内核能在浏览器里跑」的运行时证据。唯一变化的是**打开会话那一刻**：以前是
 * 拉全部历史事件自己重放一遍，现在 `readSession` 直接给一份主进程已经
 * `reduce()` 过的状态（`deserializeSessionState()` 只做数据形状转换，不重新
 * 判断任何东西）——docs/09 G5 实测过，几万条事件的会话在旧路径上会让两个进程
 * 各卡几百毫秒（ADR-0032）。状态的计算位置没有变成"两处"，只是"重放全部历史"
 * 这个动作从"每次打开会话都在渲染层做一遍"变成了"主进程本来就维护着，直接给"。
 *
 * `sessions` 列表走的是主进程的 `listSessions()` 投影，**不是回放**：
 * 为了拿几百个会话的标题去回放几百条事件流是荒唐的（ADR-0013 决策六）。
 */

interface UiState {
  sessions: ListSessionsResult;
  currentId: SessionId | undefined;
  session: SessionState | undefined;
  /**
   * 在途消息（ADR-0021）。**与 `session` 分开放，是这条设计的全部要点。**
   *
   * 它不是 `SessionState` 的副本：里面的文字尚未持久化，`message.end` 一到就归零，
   * 那之后同一段文字只存在于 `session.messages` 里。两者在时间上互斥，
   * 所以不存在 ADR-0015 要防的那种"会和回放结果分叉的第二份状态"。
   *
   * 累积与归零的逻辑全在内核的 `applyLive()` 里——这里只存结果，不做判断。
   * 它同时装着在途消息与**正在跑的工具的最新进度**（M1-c），两者的归零时机不同，
   * 见 `live-buffer.ts` 的说明。
   */
  live: LiveBuffer;
  busy: boolean;
  error: string | undefined;
  /**
   * 运行状态：Provider 配没配好、密钥后端是哪一档、配置有没有问题。
   *
   * 这**不是**会话状态的一部分，所以它待在 `session` 之外是对的——它讲的是这台机器
   * 此刻的装配情况，不是任何一条事件流的投影，回放也回放不出来。
   */
  status: Status | undefined;
  /**
   * 本会话当前的审批模式（docs/09 C6）——请求批准 / 帮我批准 / 完全访问权限。
   *
   * 跟 `status` 一样不是会话状态的一部分：它是主进程内存里的一个开关，
   * 不进事件流，也不持久化，回放回放不出来。切会话时重新拉一次。
   */
  approvalMode: ApprovalMode;
  /**
   * 崩溃恢复（M1-e，docs/04 §8）：启动时扫描出的、停在没收尾回合里的会话。
   * 跟 `status` 一样不是任何一个会话状态的一部分——它是跨会话的一张列表，
   * 所以横幅在渲染层里挂在顶层，不像 `TurnErrorBanner` 那样只在打开某个会话时才显示。
   */
  orphanedSessions: ListOrphanedSessionsResult;
  /**
   * 会话冲突（M1-e 错误态呈现）：这个会话正被另一个写句柄占用（`WriteLeaseError`，
   * 典型场景是另一个窗口/另一个小明进程正开着同一个会话）。跟 `error` 一样是纯
   * UI 态，不进事件流；跟 `error` 不一样的地方是它有专门的呈现（`SessionConflictBanner`），
   * 不落进通用兜底红条。见 `ipc-error.ts` 的 `classifyIpcError`。
   */
  sessionConflict: { sessionId: SessionId; message: string } | undefined;

  // 写成箭头属性而不是方法：zustand 的选择器会把它们从对象上摘下来单独传，
  // 方法类型在那时会触发 unbound-method——而这里确实不需要 this
  readonly refreshSessions: () => Promise<void>;
  readonly newSession: (cwd?: string) => Promise<void>;
  /** 打开原生目录选择框；用户取消时返回 undefined */
  readonly chooseWorkspace: () => Promise<string | undefined>;
  readonly respondPermission: (
    requestId: string,
    effect: 'allow' | 'deny',
    scope: 'once' | 'session' | 'always',
  ) => Promise<void>;
  readonly openSession: (id: SessionId) => Promise<void>;
  readonly setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  readonly send: (text: string, images?: readonly ImageAttachment[]) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly clearUntrusted: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly setApiKey: (providerId: string, key: string) => Promise<void>;
  readonly applyEvent: (event: PushedEvent) => void;
  readonly refreshOrphanedSessions: () => Promise<void>;
  /** 继续：从崩溃发生的那个迭代边界续跑。若那时正打开着这个会话，事件会经总线自然刷新界面 */
  readonly resumeOrphaned: (sessionId: SessionId) => Promise<void>;
  /** 放弃：写 turn.end(reason:'aborted')，语义与停止按钮相同 */
  readonly abandonOrphaned: (sessionId: SessionId) => Promise<void>;
}

/** 推送来的是信封形态，走与存储读取同一条解析路径（有版本闸门与 upcaster） */
function toCoreEvent(pushed: PushedEvent): AnyEvent | undefined {
  try {
    return parseStoredEvent(pushed);
  } catch {
    // 未知类型 / 更高版本：忽略这一条，不让整条流断掉
    return undefined;
  }
}

export const useUi = create<UiState>((set, get) => {
  /**
   * 统一收口：一次 IPC 调用失败之后该往哪个状态字段写，见 `ipc-error.ts`。
   * 有 `sessionId` 的调用点传它，让 `WriteLeaseError` 能落进专门的 `sessionConflict`；
   * 没有单一会话作用域的调用点（比如 `refreshSessions`）不传，永远走通用 `error`。
   */
  const applyIpcError = (e: unknown, sessionId?: SessionId): void => {
    const classified = classifyIpcError(e, sessionId);
    if (classified.field === 'sessionConflict') set({ sessionConflict: classified.value });
    else set({ error: classified.value });
  };

  return {
    sessions: [],
    currentId: undefined,
    session: undefined,
    live: EMPTY_LIVE,
    busy: false,
    error: undefined,
    status: undefined,
    approvalMode: 'ask',
    orphanedSessions: [],
    sessionConflict: undefined,

    refreshSessions: async () => {
      try {
        set({ sessions: await api.listSessions(), error: undefined });
      } catch (e) {
        applyIpcError(e);
      }
    },

    newSession: async (cwd) => {
      const { sessionId } = await api.createSession({
        title: cwd === undefined ? '新会话' : (cwd.split(/[/\\]/).pop() ?? '新会话'),
        ...(cwd === undefined ? {} : { cwd }),
      });
      await get().refreshSessions();
      await get().openSession(sessionId);
    },

    chooseWorkspace: async () => {
      try {
        return (await api.chooseWorkspace()).path;
      } catch (e) {
        applyIpcError(e);
        return undefined;
      }
    },

    /**
     * 应答审批。**与 stop / clearUntrusted 同一个姿态：发出去就完了，不乐观更新。**
     *
     * 在这里顺手把 `pendingPermission` 清掉会快一帧，代价是主进程若没收到
     * （requestId 已经过期、窗口刚重载），用户看到的是"已允许"而闸门其实拒了。
     * 权限状态尤其不能乐观更新——它是这套系统里最不该出现"看起来生效了"的地方。
     */
    respondPermission: async (requestId, effect, scope) => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        const { accepted } = await api.respondPermission(id, requestId, effect, scope);
        /*
         * `accepted: false` 意味着主进程里没有一个在等这个 requestId 的 waiter——
         * 请求已经过期（重复点击、上一条已经被处理、或者窗口重载丢了状态）。
         *
         * 这曾经是"点了没反应"的表现形式之一：卡片是乐观渲染之外的真实状态
         * （`pendingPermission` 来自事件流），不会自己收起，用户点了却什么都
         * 没发生，也不知道是网络慢还是点错了。这里必须给一个能看见的反馈，
         * 而不是像从前那样把返回值直接扔掉。
         */
        if (!accepted) {
          set({
            error: '这条确认请求已经失效（可能已被处理，或已出现新的待确认请求），请重新查看当前状态。',
          });
        }
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    /*
     * `readSession` 现在直接返回主进程里已经 `reduce()` 过的状态（ADR-0032，修 G4/G5）
     * ——不再是原始事件数组，这里也就不用自己重放一遍历史。`deserializeSessionState`
     * 只做"镜像 → SessionState"这一步纯转换（Map 从 entry 数组建回来），不是第二次判断。
     *
     * **`readSession` 本身也可能失败**（典型是 `WriteLeaseError`——这个会话正被另一个
     * 写句柄占用，`getSessionState` 内部照样要 `runtimeFor()`，读也要先拿到运行时）。
     * 此前这一步没有 `try/catch`，失败会变成一个没人接的 unhandled rejection，
     * 界面上什么反馈都没有——这正是"错误态呈现"这条 M1-e 条目要补的洞之一。
     */
    openSession: async (id) => {
      // 切会话必须清在途缓冲：它属于上一个会话，留着就会挂在新会话的消息流末尾
      set({
        currentId: id,
        session: undefined,
        live: EMPTY_LIVE,
        error: undefined,
        sessionConflict: undefined,
        approvalMode: 'ask',
      });
      try {
        const serialized: SerializedSessionState = await api.readSession(id);
        // 会话可能在这次 await 期间又被切走——不要用一个旧会话的状态覆盖当前会话
        if (get().currentId === id) set({ session: deserializeSessionState(serialized) });
      } catch (e) {
        applyIpcError(e, id);
        return;
      }
      try {
        const { mode } = await api.getApprovalMode(id);
        if (get().currentId === id) set({ approvalMode: mode });
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    /**
     * 切审批模式。**乐观更新是安全的**——不像 `respondPermission`，这里没有"看起来
     * 生效了、实际没生效"的窗口：切换本身没有副作用，真正受影响的是*下一次*
     * `sendUserMessage` 用哪个 `tier`，而那次调用会重新读一遍主进程里的当前值。
     */
    setApprovalMode: async (mode) => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        const result = await api.setApprovalMode(id, mode);
        if (get().currentId === id) set({ approvalMode: result.mode });
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    send: async (text, images) => {
      const id = get().currentId;
      if (id === undefined) return;
      set({ busy: true, error: undefined });
      try {
        await api.sendUserMessage(id, text, images);
        await get().refreshSessions();
      } catch (e) {
        applyIpcError(e, id);
      } finally {
        set({ busy: false });
      }
    },

    /**
     * 停止。与 `clearUntrusted` 同一个姿态：**发出去就完了，不乐观更新**。
     *
     * 真正的"已停止"由主进程推回来的 `message.interrupted` 经 reduce 得出。
     * 在这里顺手把 busy 置回 false 会快一帧，代价是取消若没生效，
     * 用户看到的是"已停止"而模型还在吐字——那比慢一帧糟得多。
     */
    stop: async () => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        await api.interrupt(id);
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    refreshStatus: async () => {
      try {
        set({ status: await api.status() });
      } catch (e) {
        applyIpcError(e);
      }
    },

    setApiKey: async (providerId, key) => {
      try {
        await api.setApiKey(providerId, key);
        await get().refreshStatus();
      } catch (e) {
        applyIpcError(e);
      }
    },

    /**
     * 解除不可信标记。**不在这里改状态**——发出去就完了，状态由主进程推回来的
     * `trust.cleared` 事件经 `reduce` 得出（ADR-0015）。
     *
     * 在这里顺手 `set({ session: { ...session, untrustedContext: undefined } })` 会快一帧，
     * 代价是 UI 上的"已解除"与事件流里的"已解除"变成两件事——而如果主进程那一侧失败了，
     * 用户看到的是解除成功、实际仍被拒绝。安全状态尤其不能乐观更新。
     */
    clearUntrusted: async () => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        await api.clearUntrusted(id);
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    refreshOrphanedSessions: async () => {
      try {
        set({ orphanedSessions: await api.listOrphanedSessions() });
      } catch (e) {
        applyIpcError(e);
      }
    },

    /**
     * 继续/放弃都不乐观更新状态本身——与 `stop`/`clearUntrusted` 同一个姿态。
     * 唯一在这里做的乐观更新是把这一条从列表里摘掉：`resolved: false` 说明
     * 扫描时的旧缓存已经过期（多半是已经被处理过一次），显示一条僵尸行没有意义。
     * 若这个会话此刻正打开着，真正的状态变化经总线推来的事件走 `applyEvent`，
     * 跟"停止"按钮完全一样，不需要在这里另外拉一次。
     */
    resumeOrphaned: async (sessionId) => {
      try {
        await api.resumeOrphanedSession(sessionId);
      } catch (e) {
        applyIpcError(e, sessionId);
      } finally {
        set({ orphanedSessions: get().orphanedSessions.filter((o) => o.sessionId !== sessionId) });
      }
    },

    abandonOrphaned: async (sessionId) => {
      try {
        await api.abandonOrphanedSession(sessionId);
      } catch (e) {
        applyIpcError(e, sessionId);
      } finally {
        set({ orphanedSessions: get().orphanedSessions.filter((o) => o.sessionId !== sessionId) });
      }
    },

    applyEvent: (pushed) => {
      const { currentId, session } = get();
      if (currentId === undefined || session === undefined) return;
      if (pushed.sessionId !== currentId) return;

      const e = toCoreEvent(pushed);
      if (e === undefined || !isCoreEvent(e)) return;

      /*
       * 两条线各走各的：
       *   · `reduce` 只认持久化事实，`message.delta` 在它眼里是空操作（ADR-0008，不动）
       *   · `applyLive` 只认在途事件，`message.end` 一到就归零
       *
       * 顺序无关紧要（两者互不读对方），但**必须都调**——只调 reduce 就是 G6 那个洞，
       * 只调 applyLive 就成了真正的第二份状态。
       */
      set({ session: reduce(session, e), live: applyLive(get().live, e) });
    },
  };
});
