import type { ContextOccupancy } from '@xm/contracts';

/** 占用合计相对路由容量。超过窗口时封顶为 1，环不再倒回去。 */
export function occupancyFillRatio(occupancy: ContextOccupancy): number {
  return Math.min(1, occupancy.totalTokens / occupancy.capacityTokens);
}

export function occupancyOverCapacity(occupancy: ContextOccupancy): boolean {
  return occupancy.totalTokens > occupancy.capacityTokens;
}

export function formatTokenCount(n: number): string {
  if (n >= 10_000) return `${String(Math.round(n / 1_000))}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export const OCCUPANCY_SEGMENTS = [
  { key: 'systemTokens', label: '系统提示词' },
  { key: 'toolsTokens', label: '工具' },
  { key: 'conversationTokens', label: '对话' },
] as const;
