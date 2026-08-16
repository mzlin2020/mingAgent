import { describe, expect, it } from 'vitest';
import { TO_BOTTOM_SIZE_PX } from '../src/renderer/lib/layout.js';
import {
  PIN_THRESHOLD_PX,
  TO_BOTTOM_LAYOUT,
  isPinnedToBottom,
  toBottomLayoutContribution,
} from '../src/renderer/lib/scroll-pin.js';

describe('贴底判定', () => {
  it('距底部小于阈值算贴底，超过就不跟', () => {
    expect(isPinnedToBottom(1000, 936, 64)).toBe(true);
    expect(isPinnedToBottom(1000, 935, 64)).toBe(true);
    expect(isPinnedToBottom(1000, 800, 64)).toBe(false);
    expect(PIN_THRESHOLD_PX).toBe(64);
  });
});

describe('回到底部槽的布局贡献', () => {
  it('零高度槽 + margin-top:-34px 不撑高 scrollHeight', () => {
    expect(TO_BOTTOM_LAYOUT).toEqual({
      slotHeight: 0,
      buttonHeight: 34,
      buttonMarginTop: -34,
    });
    expect(toBottomLayoutContribution(TO_BOTTOM_LAYOUT)).toBe(0);
    expect(TO_BOTTOM_SIZE_PX).toBe(34);
  });

  it('🔴 去掉 margin-top:-34px 就会撑高——贴底判定会被它自己推翻', () => {
    expect(
      toBottomLayoutContribution({ slotHeight: 0, buttonHeight: 34, buttonMarginTop: 0 }),
    ).toBe(34);
    expect(toBottomLayoutContribution(TO_BOTTOM_LAYOUT)).toBe(0);
  });
});
