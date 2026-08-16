/**
 * 桌面端 UI 偏好（ADR-0077）。
 *
 * 能进这里，当且仅当它**既不进模型请求、也不参与任何判定**。
 * 详情栏宽一点还是窄一点不改变一次权限判定，也不进上下文——所以走 `localStorage`，
 * 不进事件流，也不进 `config.json`。
 *
 * 键名闭集：详情栏宽/开、主题档位、Enter 行为。
 */

import {
  DETAILS_DEFAULT,
  type DetailsPref,
  clampDetailsWidth,
} from './columns.js';

export interface UiPrefStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export const DETAILS_WIDTH_KEY = 'xm.ui.detailsWidth';
export const DETAILS_OPEN_KEY = 'xm.ui.detailsOpen';
export const THEME_KEY = 'xm.ui.theme';
export const ENTER_KEY = 'xm.ui.enterToSend';
export const UI_PREFS_EVENT = 'xm-ui-prefs';

export type ThemePref = 'system' | 'light' | 'dark';

const DEFAULT_PREF: DetailsPref = { width: DETAILS_DEFAULT, open: false };

export function readDetailsPref(store: UiPrefStore): DetailsPref {
  return {
    width: readWidth(store),
    open: readOpen(store),
  };
}

export function writeDetailsWidth(store: UiPrefStore, width: number): DetailsPref {
  const next: DetailsPref = { width: clampDetailsWidth(width), open: readOpen(store) };
  persist(store, DETAILS_WIDTH_KEY, String(next.width));
  return next;
}

export function writeDetailsOpen(store: UiPrefStore, open: boolean): DetailsPref {
  const next: DetailsPref = { width: readWidth(store), open };
  persist(store, DETAILS_OPEN_KEY, open ? '1' : '0');
  return next;
}

export function readThemePref(store: UiPrefStore): ThemePref {
  const raw = safeGet(store, THEME_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export function writeThemePref(store: UiPrefStore, pref: ThemePref): ThemePref {
  persist(store, THEME_KEY, pref);
  notifyPrefs();
  return pref;
}

export function applyThemePref(pref: ThemePref, root: { dataset: { theme?: string } }): void {
  if (pref === 'system') {
    delete root.dataset.theme;
    return;
  }
  root.dataset.theme = pref;
}

/** true = Enter 发送；false = Enter 换行 */
export function readEnterToSend(store: UiPrefStore): boolean {
  const raw = safeGet(store, ENTER_KEY);
  if (raw === '0') return false;
  return true;
}

export function writeEnterToSend(store: UiPrefStore, send: boolean): boolean {
  persist(store, ENTER_KEY, send ? '1' : '0');
  notifyPrefs();
  return send;
}

/**
 * 不直接写 `window`：`tsconfig.tests.json` 只有 node 类型，
 * `ui-prefs.test.ts` 会把本文件拉进测试工程。
 */
interface PrefsBroadcast {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  dispatchEvent(event: object): boolean;
}

function prefsWindow(): PrefsBroadcast | undefined {
  return (globalThis as { window?: PrefsBroadcast }).window;
}

export function subscribeUiPrefs(listener: () => void): () => void {
  const w = prefsWindow();
  if (w === undefined) return () => undefined;
  w.addEventListener(UI_PREFS_EVENT, listener);
  return () => {
    w.removeEventListener(UI_PREFS_EVENT, listener);
  };
}

function notifyPrefs(): void {
  const w = prefsWindow();
  const EventCtor = (globalThis as { Event?: new (type: string) => object }).Event;
  if (w === undefined || EventCtor === undefined) return;
  w.dispatchEvent(new EventCtor(UI_PREFS_EVENT));
}

function readWidth(store: UiPrefStore): number {
  const raw = safeGet(store, DETAILS_WIDTH_KEY);
  if (raw === null) return DETAILS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampDetailsWidth(parsed) : DETAILS_DEFAULT;
}

function readOpen(store: UiPrefStore): boolean {
  const raw = safeGet(store, DETAILS_OPEN_KEY);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return DEFAULT_PREF.open;
}

function persist(store: UiPrefStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：这一帧用内存值，下次启动回默认。 */
  }
}

function safeGet(store: UiPrefStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
