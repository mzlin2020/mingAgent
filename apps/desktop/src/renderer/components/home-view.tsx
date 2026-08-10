import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { SessionStatusBadge } from './session-status.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * Home：最近会话（按 listSessions 的 updatedAt 倒序，服务端已排好）。
 * 不展示 cwd / 项目列（ADR-0037）。
 */
export function HomeView(): ReactNode {
  const sessions = useUi((s) => s.sessions);
  const openSession = useUi((s) => s.openSession);
  const newSession = useUi((s) => s.newSession);
  const chooseWorkspace = useUi((s) => s.chooseWorkspace);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-2 py-8">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">最近会话</h1>
          <p className="mt-1 text-xs text-[var(--xm-fg-muted)]">按最近活动排序。关闭标签不会删除会话。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            className="gap-1.5 text-xs"
            onClick={() => {
              void chooseWorkspace().then((cwd) =>
                cwd === undefined ? undefined : newSession(cwd),
              );
            }}
          >
            <FolderIcon />
            从目录创建
          </Button>
          <Button
            className="gap-1.5"
            onClick={() => {
              void newSession();
            }}
          >
            <PlusIcon />
            新建会话
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--xm-border)] px-4 py-12 text-center text-sm text-[var(--xm-fg-muted)]">
          还没有会话。新建一个开始。
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                onClick={() => {
                  void openSession(s.sessionId);
                }}
                className={cn(
                  'flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm transition-colors',
                  'text-[var(--xm-fg)] hover:bg-[var(--xm-surface)]',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {s.title === '' || s.title === undefined ? '未命名' : s.title}
                </span>
                <SessionStatusBadge status={s.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlusIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function FolderIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
