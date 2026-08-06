import { create } from 'zustand';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { isCoreEvent, parseStoredEvent } from '@xm/contracts';
import type { LiveBuffer, SessionState } from '@xm/kernel';
import { applyLive, emptySessionState, reduce } from '@xm/kernel';
import type { ListSessionsResult, PushedEvent, StatusResult } from '../shared/ipc.js';
import type { z } from 'zod';
import { api } from './bridge.js';

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
 * 这同时是「内核能在浏览器里跑」的运行时证据——`reduce` 在这里跑在没有 Node 的
 * 渲染进程里，一个 `node:*` 的 import 都活不下来。
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
   */
  live: LiveBuffer | undefined;
  busy: boolean;
  error: string | undefined;
  /**
   * 运行状态：Provider 配没配好、密钥后端是哪一档、配置有没有问题。
   *
   * 这**不是**会话状态的一部分，所以它待在 `session` 之外是对的——它讲的是这台机器
   * 此刻的装配情况，不是任何一条事件流的投影，回放也回放不出来。
   */
  status: Status | undefined;

  // 写成箭头属性而不是方法：zustand 的选择器会把它们从对象上摘下来单独传，
  // 方法类型在那时会触发 unbound-method——而这里确实不需要 this
  readonly refreshSessions: () => Promise<void>;
  readonly newSession: () => Promise<void>;
  readonly openSession: (id: SessionId) => Promise<void>;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly clearUntrusted: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly setApiKey: (providerId: string, key: string) => Promise<void>;
  readonly applyEvent: (event: PushedEvent) => void;
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

export const useUi = create<UiState>((set, get) => ({
  sessions: [],
  currentId: undefined,
  session: undefined,
  live: undefined,
  busy: false,
  error: undefined,
  status: undefined,

  refreshSessions: async () => {
    try {
      set({ sessions: await api.listSessions(), error: undefined });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  newSession: async () => {
    const { sessionId } = await api.createSession('新会话');
    await get().refreshSessions();
    await get().openSession(sessionId);
  },

  openSession: async (id) => {
    // 切会话必须清在途缓冲：它属于上一个会话，留着就会挂在新会话的消息流末尾
    set({ currentId: id, session: undefined, live: undefined, error: undefined });
    const events = await api.readSession(id);
    let state = emptySessionState(id);
    for (const raw of events) {
      const e = toCoreEvent(raw);
      if (e !== undefined && isCoreEvent(e)) state = reduce(state, e);
    }
    set({ session: state });
  },

  send: async (text) => {
    const id = get().currentId;
    if (id === undefined) return;
    set({ busy: true, error: undefined });
    try {
      await api.sendUserMessage(id, text);
      await get().refreshSessions();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
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
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshStatus: async () => {
    try {
      set({ status: await api.status() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  setApiKey: async (providerId, key) => {
    try {
      await api.setApiKey(providerId, key);
      await get().refreshStatus();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
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
      set({ error: e instanceof Error ? e.message : String(e) });
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
}));
