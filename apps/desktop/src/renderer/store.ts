import { create } from 'zustand';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { isCoreEvent, parseStoredEvent } from '@xm/contracts';
import type { LiveBuffer, SessionState } from '@xm/kernel';
import { EMPTY_LIVE, applyLive, deserializeSessionState, reduce } from '@xm/kernel';
import type {
  ImageAttachment,
  ListSessionsResult,
  PushedEvent,
  StatusResult,
} from '../shared/ipc.js';
import type { z } from 'zod';
import { api } from './bridge.js';
import { IpcError, classifyIpcError } from './ipc-error.js';
import type { OrphanedSlice } from './orphaned-sessions.js';
import { createOrphanedSlice } from './orphaned-sessions.js';
import type { CardsSlice } from './cards-slice.js';
import { createCardsSlice, mergeCard } from './cards-slice.js';

type Status = z.infer<typeof StatusResult>;

/**
 * 渲染层状态。
 *
 * ── 会话状态由 `reduce()` 算出，UI 不维护第二份真相（ADR-0015）──
 *
 * 消息列表、运行中的工具、被拒绝的操作……全都从事件流 reduce 出来，跟主进程用的是
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

/** 壳层主区：Home 最近会话 vs 当前焦点会话（ADR-0037） */
export type ShellView = 'home' | 'chat' | 'security';

interface UiState extends OrphanedSlice, CardsSlice {
  sessions: ListSessionsResult;
  /**
   * 顶栏 tabs 的打开集合（ADR-0037）。纯 UI 态，不持久化、不进事件流。
   * 关 tab ≠ 删会话。
   */
  openIds: readonly SessionId[];
  /** Home 列表，或焦点会话的对话主视图 */
  shellView: ShellView;
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
  pendingInputs: readonly { readonly id: number; readonly kind: 'followup' | 'steer'; readonly text: string }[];
  error: string | undefined;
  /**
   * 运行状态：Provider 配没配好、密钥后端是哪一档、配置有没有问题。
   *
   * 这**不是**会话状态的一部分，所以它待在 `session` 之外是对的——它讲的是这台机器
   * 此刻的装配情况，不是任何一条事件流的投影，回放也回放不出来。
   */
  status: Status | undefined;
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
  readonly openSession: (id: SessionId) => Promise<void>;
  /** 回到 Home；保留 tabs 打开集合与 currentId，只切主区 */
  readonly goHome: () => void;
  readonly openSecurity: () => void;
  /**
   * 关闭一个 tab（移出打开集合）。**不删除**会话数据。
   * 若关掉的是焦点，则聚焦剩余最后一个 tab，否则回 Home。
   */
  readonly closeTab: (id: SessionId) => Promise<void>;
  /**
   * 解除本会话的不可信标记（ADR-0019）。**不乐观更新**：真实状态来自事件流
   * （`trust.cleared` → `reduce` → 推回渲染层），这里抢先改一份本地副本就等于
   * 在权限相关的 UI 上显示一个可能没生效的结果。
   */
  readonly clearUntrusted: () => Promise<void>;
  readonly send: (text: string, images?: readonly ImageAttachment[]) => Promise<void>;
  readonly steer: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly setApiKey: (providerId: string, key: string) => Promise<void>;
  readonly applyEvent: (event: PushedEvent) => void;
}

function withOpenId(openIds: readonly SessionId[], id: SessionId): readonly SessionId[] {
  return openIds.includes(id) ? openIds : [...openIds, id];
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
  let pendingId = 0;
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
    // 崩溃恢复那一组（`orphanedSessions` 与三个动作）见 `orphaned-sessions.ts`
    ...createOrphanedSlice(set, get, applyIpcError),
    // 工具卡片那一组见 `cards-slice.ts`——它是投影，不是会话状态
    ...createCardsSlice(set, get, applyIpcError),

    sessions: [],
    openIds: [],
    shellView: 'home',
    currentId: undefined,
    session: undefined,
    live: EMPTY_LIVE,
    busy: false,
    pendingInputs: [],
    error: undefined,
    status: undefined,
    sessionConflict: undefined,

    refreshSessions: async () => {
      try {
        set({ sessions: await api.listSessions(), error: undefined });
      } catch (e) {
        applyIpcError(e);
      }
    },

    newSession: async (cwd) => {
      try {
        const { sessionId } = await api.createSession({
          title: cwd === undefined ? '新会话' : (cwd.split(/[/\\]/).pop() ?? '新会话'),
          ...(cwd === undefined ? {} : { cwd }),
        });
        await get().refreshSessions();
        await get().openSession(sessionId);
      } catch (e) {
        if (cwd === undefined && e instanceof IpcError && e.code === 'WorkspaceRequiredError') {
          const picked = await get().chooseWorkspace();
          if (picked !== undefined) await get().newSession(picked);
          return;
        }
        applyIpcError(e);
      }
    },

    chooseWorkspace: async () => {
      try {
        return (await api.chooseWorkspace()).path;
      } catch (e) {
        applyIpcError(e);
        return undefined;
      }
    },

    openSession: async (id) => {
      // 切会话必须清在途缓冲：它属于上一个会话，留着就会挂在新会话的消息流末尾
      set({
        currentId: id,
        openIds: withOpenId(get().openIds, id),
        shellView: 'chat',
        session: undefined,
        cards: new Map(),
        live: EMPTY_LIVE,
        pendingInputs: [],
        error: undefined,
        sessionConflict: undefined,
      });
      try {
        const { cards, ...serialized } = await api.readSession(id);
        // 会话可能在这次 await 期间又被切走——不要用一个旧会话的状态覆盖当前会话
        if (get().currentId === id) {
          set({
            session: deserializeSessionState(serialized),
            cards: new Map(cards),
          });
        }
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    goHome: () => {
      set({ shellView: 'home', error: undefined, sessionConflict: undefined });
    },

    openSecurity: () => {
      set({ shellView: 'security', error: undefined, sessionConflict: undefined });
      void get().refreshStatus();
    },

    closeTab: async (id) => {
      const openIds = get().openIds.filter((x) => x !== id);
      const wasCurrent = get().currentId === id;
      if (!wasCurrent) {
        set({ openIds });
        return;
      }
      const next = openIds[openIds.length - 1];
      if (next === undefined) {
        set({
          openIds,
          currentId: undefined,
          session: undefined,
          live: EMPTY_LIVE,
          shellView: 'home',
          error: undefined,
          sessionConflict: undefined,
        });
        return;
      }
      set({ openIds });
      await get().openSession(next);
    },

    clearUntrusted: async () => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        await api.clearUntrusted(id);
      } catch (e) {
        applyIpcError(e, id);
      }
    },

    send: async (text, images) => {
      const id = get().currentId;
      if (id === undefined) return;
      set({ busy: true, error: undefined });
      try {
        const result = await api.sendUserMessage(id, text, images);
        if (result.reason === 'queued') {
          set({
            pendingInputs: [
              ...get().pendingInputs,
              { id: ++pendingId, kind: 'followup', text },
            ],
          });
        }
        await get().refreshSessions();
      } catch (e) {
        applyIpcError(e, id);
      } finally {
        set({ busy: false });
      }
    },

    steer: async (text) => {
      const id = get().currentId;
      if (id === undefined) return;
      try {
        const result = await api.steerUserMessage(id, text);
        if (result.reason === 'queued') {
          set({
            pendingInputs: [
              ...get().pendingInputs,
              { id: ++pendingId, kind: 'steer', text },
            ],
          });
        }
      } catch (error) {
        applyIpcError(error, id);
      }
    },

    /**
     * 停止。**发出去就完了，不乐观更新**。
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

    applyEvent: (pushed) => {
      const { currentId, session } = get();
      if (currentId === undefined || session === undefined) return;
      if (pushed.sessionId !== currentId) return;

      const e = toCoreEvent(pushed);
      if (e === undefined || !isCoreEvent(e)) return;
      if (e.type === 'turn.start') {
        const claimedText = e.payload.input
          .filter((block): block is Extract<(typeof e.payload.input)[number], { type: 'text' }> =>
            block.type === 'text',
          )
          .map((block) => block.text);
        set({
          busy: false,
          pendingInputs: get().pendingInputs.filter((item) => !claimedText.includes(item.text)),
        });
      }

      /*
       * 两条线各走各的：
       *   · `reduce` 只认持久化事实，`message.delta` 在它眼里是空操作（ADR-0008，不动）
       *   · `applyLive` 只认在途事件，`message.end` 一到就归零
       *
       * 顺序无关紧要（两者互不读对方），但**必须都调**——只调 reduce 就是 G6 那个洞，
       * 只调 applyLive 就成了真正的第二份状态。
       */
      set({
        session: reduce(session, e),
        live: applyLive(get().live, e),
        cards: mergeCard(get().cards, e, pushed.card),
      });
    },
  };
});
