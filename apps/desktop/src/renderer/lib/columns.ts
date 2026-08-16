/**
 * 两栏让位链（ADR-0074 / docs/12 §5.2）。
 *
 * 纯函数：输出只是 (视口宽, 详情栏偏好) 的函数，没有迟滞。
 * 自动关闭是派生结果，**绝不回写偏好**——窗口拉宽后详情栏必须自己回来。
 *
 * 让位顺序（契约，不可改序）：
 * 1. 都放得下 → 各自用偏好宽度。
 * 2. 放不下 → 先把详情栏往 `DETAILS_MIN` 压（正文守住 `CENTER_MIN`）。
 * 3. 还放不下 → 关掉详情栏（`details: 0`），正文吸收剩余亏空，此时才允许低于 `CENTER_MIN`。
 *
 * 只有两栏。参考实现那条三参数链（侧栏永不让位）不在这里——
 * 小明没有左侧会话侧栏（ADR-0037），一个恒为 0 的参数会让人以为侧栏只是没接上。
 */

export interface Columns {
  readonly center: number;
  readonly details: number;
}

export interface DetailsPref {
  readonly width: number;
  readonly open: boolean;
}

export interface DetailsLayout {
  readonly width: number;
  readonly collapsed: boolean;
}

export const CENTER_MIN = 640;
export const DETAILS_MIN = 300;
export const DETAILS_MAX = 520;
export const DETAILS_DEFAULT = 360;

export function clampDetailsWidth(width: number): number {
  if (!Number.isFinite(width)) return DETAILS_DEFAULT;
  return Math.min(DETAILS_MAX, Math.max(DETAILS_MIN, width));
}

export function computeColumns(viewport: number, details: number): Columns {
  const pref = clampDetailsWidth(details);
  const vp = Number.isFinite(viewport) ? Math.max(0, viewport) : 0;

  if (vp >= CENTER_MIN + pref) {
    return { center: vp - pref, details: pref };
  }
  if (vp >= CENTER_MIN + DETAILS_MIN) {
    return { center: CENTER_MIN, details: vp - CENTER_MIN };
  }
  return { center: vp, details: 0 };
}

/**
 * 把偏好投影成这一帧要画的宽度。自动关闭只出现在返回值里，
 * 调用方不得据此回写 `pref.width` / `pref.open`。
 */
export function resolveDetailsLayout(viewport: number, pref: DetailsPref): DetailsLayout {
  if (!pref.open) return { width: 0, collapsed: true };
  const width = computeColumns(viewport, pref.width).details;
  return { width, collapsed: width === 0 };
}
