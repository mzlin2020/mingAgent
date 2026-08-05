import { create } from 'zustand';
import type { AnyEvent, SessionId } from '@xm/contracts';
import { isCoreEvent, parseStoredEvent } from '@xm/contracts';
import type { SessionState } from '@xm/kernel';
import { emptySessionState, reduce } from '@xm/kernel';
import type { ListSessionsResult, PushedEvent } from '../shared/ipc.js';
import { api } from './bridge.js';

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
  busy: boolean;
  error: string | undefined;

  // 写成箭头属性而不是方法：zustand 的选择器会把它们从对象上摘下来单独传，
  // 方法类型在那时会触发 unbound-method——而这里确实不需要 this
  readonly refreshSessions: () => Promise<void>;
  readonly newSession: () => Promise<void>;
  readonly openSession: (id: SessionId) => Promise<void>;
  readonly send: (text: string) => Promise<void>;
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
  busy: false,
  error: undefined,

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
    set({ currentId: id, session: undefined, error: undefined });
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

  applyEvent: (pushed) => {
    const { currentId, session } = get();
    if (currentId === undefined || session === undefined) return;
    if (pushed.sessionId !== currentId) return;

    const e = toCoreEvent(pushed);
    if (e === undefined || !isCoreEvent(e)) return;
    set({ session: reduce(session, e) });
  },
}));
