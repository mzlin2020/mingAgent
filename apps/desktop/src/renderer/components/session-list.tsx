import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ListSessionsResult } from '../../shared/ipc.js';
import { Button } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

type SortMode = 'active' | 'name';

const STATUS_LABEL: Record<ListSessionsResult[number]['status'], string> = {
  running: '运行中',
  interrupted: '已中断',
  idle: '',
};

/**
 * 状态徽标（M1-e 会话列表状态整合）。
 *
 * `idle` 不画任何东西——默认态不加视觉噪音，跟 `SetupBanner` 一贯的克制风格一致
 * （"只在状态有出路/值得关注时才出现"）。`running`/`interrupted` 复用既有的
 * `--xm-accent`/`--xm-danger` 两个 CSS 变量，不新增颜色：`interrupted` 的红色系
 * 与 `TurnErrorBanner`/`InterruptedSessionBanner` 同色系，用户已经在别处建立了
 * "这个颜色=需要关注"的心智。
 */
function StatusBadge({ status }: { status: ListSessionsResult[number]['status'] }): ReactNode {
  if (status === 'idle') return null;
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-none',
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

/** 状态优先级：运行中 > 已中断 > 空闲。桶内维持服务端已有的 `updated_at DESC` 顺序不变 */
const STATUS_RANK: Record<ListSessionsResult[number]['status'], number> = {
  running: 0,
  interrupted: 1,
  idle: 2,
};

function sortSessions(sessions: ListSessionsResult, mode: SortMode): ListSessionsResult {
  if (mode === 'name') {
    return [...sessions].sort((a, b) => (a.title ?? '未命名').localeCompare(b.title ?? '未命名'));
  }
  // 'active'：按状态分桶，桶内保持服务端已经排好的顺序（数组 sort 是稳定的）
  return [...sessions].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
}

export function SessionList(): ReactNode {
  const { sessions, currentId } = useUi();
  const newSession = useUi((s) => s.newSession);
  const openSession = useUi((s) => s.openSession);
  const chooseWorkspace = useUi((s) => s.chooseWorkspace);
  // 纯前端偏好，不持久化——重启回默认，避免为一个低风险的 UI 偏好开新的持久化面
  const [sortMode, setSortMode] = useState<SortMode>('active');

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--xm-border)] bg-[var(--xm-surface-2)]">
      <div className="flex flex-col gap-1 p-2">
        <Button className="w-full" onClick={() => void newSession()}>
          新会话
        </Button>
        {/*
          选目录再建会话 —— 主 DoD 任务（"读这个目录…"）的前提。
          会话的 cwd 决定模型给的相对路径落在哪，而它记在 `session.created` 里、
          此后不可改：换目录就是换一个会话，而不是让同一条事件流中途改变含义。
        */}
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => {
            void chooseWorkspace().then((cwd) => (cwd === undefined ? undefined : newSession(cwd)));
          }}
        >
          选择目录，新建会话
        </Button>
      </div>

      {sessions.length > 0 && (
        <div className="flex items-center justify-end gap-1 px-2 pb-1 text-[10px] text-[var(--xm-fg-muted)]">
          <span>排序：</span>
          <button
            onClick={() => {
              setSortMode('active');
            }}
            className={cn('rounded px-1.5 py-0.5', sortMode === 'active' && 'bg-[var(--xm-surface)] font-medium')}
          >
            活跃优先
          </button>
          <button
            onClick={() => {
              setSortMode('name');
            }}
            className={cn('rounded px-1.5 py-0.5', sortMode === 'name' && 'bg-[var(--xm-surface)] font-medium')}
          >
            按名称
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-[var(--xm-fg-muted)]">还没有会话</p>
        )}
        {sortSessions(sessions, sortMode).map((s) => (
          <button
            key={s.sessionId}
            onClick={() => void openSession(s.sessionId)}
            className={cn(
              'mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm',
              s.sessionId === currentId
                ? 'bg-[var(--xm-surface)] font-medium'
                : 'text-[var(--xm-fg-muted)] hover:bg-[var(--xm-surface)]',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{s.title ?? '未命名'}</span>
            <StatusBadge status={s.status} />
          </button>
        ))}
      </div>
    </aside>
  );
}
