import { describe, expect, it } from 'vitest';
import {
  CENTER_MIN,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  clampDetailsWidth,
  computeColumns,
  resolveDetailsLayout,
} from '../src/renderer/lib/columns.js';

/**
 * 两栏让位链（ADR-0074）。数字用字面量而不是 `CENTER_MIN + …` 拼出来：
 * 反向演练要的就是"有人把下限拿掉"时这些断言变红，用常量拼输入会跟着错一起漂。
 */
describe('computeColumns', () => {
  it('都放得下时各用偏好宽度', () => {
    expect(computeColumns(1200, 360)).toEqual({ center: 840, details: 360 });
    expect(computeColumns(1000, 360)).toEqual({ center: 640, details: 360 });
  });

  it('放不下时先把详情栏往下限压，正文守住 640', () => {
    expect(computeColumns(980, 360)).toEqual({ center: 640, details: 340 });
    expect(computeColumns(940, 360)).toEqual({ center: 640, details: 300 });
  });

  it('还放不下就关详情栏，正文吸收亏空（此时才允许低于 640）', () => {
    expect(computeColumns(939, 360)).toEqual({ center: 939, details: 0 });
    expect(computeColumns(800, 360)).toEqual({ center: 800, details: 0 });
  });

  it('偏好超出 [300, 520] 先夹紧再求解', () => {
    expect(computeColumns(2000, 100)).toEqual({ center: 1700, details: 300 });
    expect(computeColumns(2000, 999)).toEqual({ center: 1480, details: 520 });
    expect(clampDetailsWidth(Number.NaN)).toBe(DETAILS_DEFAULT);
  });

  it('非法视口当成 0，详情栏关掉', () => {
    expect(computeColumns(0, 360)).toEqual({ center: 0, details: 0 });
    expect(computeColumns(-40, 360)).toEqual({ center: 0, details: 0 });
    expect(computeColumns(Number.NaN, 360)).toEqual({ center: 0, details: 0 });
  });

  it('常量本身就是契约：改数字等于改让位链', () => {
    expect(CENTER_MIN).toBe(640);
    expect(DETAILS_MIN).toBe(300);
    expect(DETAILS_MAX).toBe(520);
    expect(DETAILS_DEFAULT).toBe(360);
  });
});

describe('resolveDetailsLayout', () => {
  it('用户关栏时宽度为 0，与视口无关', () => {
    expect(resolveDetailsLayout(1600, { width: 360, open: false })).toEqual({
      width: 0,
      collapsed: true,
    });
  });

  it('自动关闭不得碰偏好：拉宽后按原宽度回来', () => {
    const pref = Object.freeze({ width: 360, open: true });
    expect(resolveDetailsLayout(800, pref)).toEqual({ width: 0, collapsed: true });
    expect(pref).toEqual({ width: 360, open: true });
    expect(resolveDetailsLayout(1200, pref)).toEqual({ width: 360, collapsed: false });
  });
});
