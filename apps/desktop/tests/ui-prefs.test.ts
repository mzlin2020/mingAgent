import { describe, expect, it } from 'vitest';
import { resolveDetailsLayout } from '../src/renderer/lib/columns.js';
import {
  DETAILS_OPEN_KEY,
  DETAILS_WIDTH_KEY,
  ENTER_KEY,
  THEME_KEY,
  applyThemePref,
  readDetailsPref,
  readEnterToSend,
  readThemePref,
  writeDetailsOpen,
  writeDetailsWidth,
  writeEnterToSend,
  writeThemePref,
  type UiPrefStore,
} from '../src/renderer/lib/ui-prefs.js';

function memoryStore(seed: Record<string, string> = {}): UiPrefStore {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('readDetailsPref / writeDetails*', () => {
  it('缺省是关着的 360', () => {
    expect(readDetailsPref(memoryStore())).toEqual({ width: 360, open: false });
  });

  it('只接受 0/1 作为开关，其它写法回默认', () => {
    expect(readDetailsPref(memoryStore({ [DETAILS_OPEN_KEY]: '1' })).open).toBe(true);
    expect(readDetailsPref(memoryStore({ [DETAILS_OPEN_KEY]: 'yes' })).open).toBe(false);
  });

  it('写入宽度会夹紧，读回的就是夹紧后的值', () => {
    const store = memoryStore();
    expect(writeDetailsWidth(store, 180).width).toBe(300);
    expect(writeDetailsWidth(store, 800).width).toBe(520);
    expect(readDetailsPref(store).width).toBe(520);
  });

  it('写开关不改宽度，写宽度不改开关', () => {
    const store = memoryStore();
    writeDetailsWidth(store, 400);
    writeDetailsOpen(store, true);
    expect(readDetailsPref(store)).toEqual({ width: 400, open: true });
    writeDetailsWidth(store, 300);
    expect(readDetailsPref(store)).toEqual({ width: 300, open: true });
  });
});

describe('自动关闭不得回写偏好', () => {
  it('窄窗口投影为 0 之后，store 里的宽度仍在，拉宽按原值回来', () => {
    const store = memoryStore({
      [DETAILS_WIDTH_KEY]: '400',
      [DETAILS_OPEN_KEY]: '1',
    });
    const pref = readDetailsPref(store);
    expect(resolveDetailsLayout(800, pref)).toEqual({ width: 0, collapsed: true });
    expect(readDetailsPref(store)).toEqual({ width: 400, open: true });
    expect(resolveDetailsLayout(1200, readDetailsPref(store))).toEqual({
      width: 400,
      collapsed: false,
    });
  });
});

describe('主题与 Enter 偏好（M3.5-e）', () => {
  it('缺省跟随系统、Enter 发送', () => {
    const store = memoryStore();
    expect(readThemePref(store)).toBe('system');
    expect(readEnterToSend(store)).toBe(true);
  });

  it('只认 system/light/dark，其它回跟随系统', () => {
    expect(readThemePref(memoryStore({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readThemePref(memoryStore({ [THEME_KEY]: 'sepia' }))).toBe('system');
  });

  it('Enter 只认 0 为换行，其它（含缺省）为发送', () => {
    expect(readEnterToSend(memoryStore({ [ENTER_KEY]: '0' }))).toBe(false);
    expect(readEnterToSend(memoryStore({ [ENTER_KEY]: 'no' }))).toBe(true);
  });

  it('手动浅色会写 data-theme=light，跟随系统则删掉属性', () => {
    const root = { dataset: { theme: 'dark' } };
    applyThemePref('light', root);
    expect(root.dataset.theme).toBe('light');
    applyThemePref('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it('写入后能读回', () => {
    const store = memoryStore();
    writeThemePref(store, 'dark');
    writeEnterToSend(store, false);
    expect(readThemePref(store)).toBe('dark');
    expect(readEnterToSend(store)).toBe(false);
  });
});
