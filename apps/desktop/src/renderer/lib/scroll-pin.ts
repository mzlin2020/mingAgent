/**
 * 对话流贴底与「回到底部」槽的布局贡献（M3.5-c）。
 *
 * 贴底判定看的是 scrollHeight。如果回到底部的圆钮自己占了一截高度，
 * 它就会把「已经在底部」判成「还差 34px」——新消息来了不跟，按钮自己却还在。
 * 所以槽必须零高度，钮用负 margin 拉上去。这条可以单测，不必等真机滚动。
 */

import { TO_BOTTOM_SIZE_PX } from './layout.js';

/** 距底部少过这个像素数，就还算贴底（橡皮筋 / 亚像素都不该把跟滚关掉） */
export const PIN_THRESHOLD_PX = 64;

export interface ToBottomLayout {
  readonly slotHeight: number;
  readonly buttonHeight: number;
  readonly buttonMarginTop: number;
}

/** 当前实现用的槽：零高 + 钮正好被负 margin 拉出文档流 */
export const TO_BOTTOM_LAYOUT: ToBottomLayout = {
  slotHeight: 0,
  buttonHeight: TO_BOTTOM_SIZE_PX,
  buttonMarginTop: -TO_BOTTOM_SIZE_PX,
};

/**
 * 这个槽会给父滚动容器贡献多少 scrollHeight。
 *
 * 负 margin 把钮从槽里拉走：`height + buttonHeight + marginTop`。
 * 设计值必须是 0；任何人拿掉 `-34px` 都会让这个函数返回 34。
 */
export function toBottomLayoutContribution(layout: ToBottomLayout): number {
  return layout.slotHeight + layout.buttonHeight + layout.buttonMarginTop;
}

export function isPinnedToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
