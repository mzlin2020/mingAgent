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
 */
export function SessionStatusBadge({
  status,
}: {
  readonly status: ListSessionsResult[number]['status'];
}): ReactNode {
  if (status === 'idle') return null;
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-none',
        status === 'running' ? 'text-[var(--xm-accent)]' : 'bg-[var(--xm-danger-bg)] text-[var(--xm-danger)]',
      )}
    >
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          status === 'running' ? 'bg-[var(--xm-accent)]' : 'bg-[var(--xm-danger)]',
        )}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
