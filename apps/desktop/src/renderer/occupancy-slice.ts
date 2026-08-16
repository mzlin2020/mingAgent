import type { ContextOccupancy } from '@xm/contracts';

/**
 * 上下文占用投影（M3.5-f）。不是会话状态：打开时整份替换、之后只跟着
 * 带 `occupancy` 的推送更新、切会话即清空。
 */
export interface OccupancySlice {
  occupancy: ContextOccupancy | undefined;
}

export const emptyOccupancyOnSwitch = (): OccupancySlice => ({ occupancy: undefined });

export const mergeOccupancy = (
  current: ContextOccupancy | undefined,
  next: ContextOccupancy | undefined,
): ContextOccupancy | undefined => next ?? current;
