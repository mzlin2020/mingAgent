import type { ReactNode } from 'react';
import type { ListSessionsResult } from '../../shared/ipc.js';
import { cn } from '../lib/cn.js';

const STATUS_LABEL: Record<ListSessionsResult[number]['status'], string> = {
  running: '运行中',
  interrupted: '已中断',
  idle: '',
};

/**
 * 会话状态徽标（M1-e）。`idle` 不画——默认态不加噪音。
 * 从原侧栏抽出，供 Home / tabs 共用（ADR-0037）。
 *
 * 两种状态走**同一个 chip 形状**，只换颜色。上一版 `running` 没有底色、`interrupted` 有，
 * 于是同一列里两个徽标的视觉尺寸对不齐。
 */
export function SessionStatusBadge({
  status,
}: {
  readonly status: ListSessionsResult[number]['status'];
}): ReactNode {
  if (status === 'idle') return null;
  const running = status === 'running';
  return (
    <span
      className={cn(
        'ml-2 inline-flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5',
        'text-micro leading-none',
        running ? 'bg-accent-weak text-accent' : 'bg-danger-bg text-danger',
      )}
    >
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-chip',
          running ? 'animate-pulse bg-accent' : 'bg-danger',
        )}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
