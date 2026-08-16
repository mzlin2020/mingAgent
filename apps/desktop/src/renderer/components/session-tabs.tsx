import type { ReactNode, MouseEvent } from 'react';
import { Button } from './ui.js';
import { SessionStatusBadge } from './session-status.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 顶栏会话 tabs + Home（ADR-0037）。
 * tabs = 打开集合；焦点仍是单一 `currentId`。新建在 Home，顶栏不放 `+`。
 *
 * 选中态是底部 2px 强调色指示条（ADR-0074），不是填充。填充选中态要求顶栏与 tab
 * 不同色；指示条没有这个约束，顶栏可以坐在页面底色上。
 */
export function SessionTabs(): ReactNode {
  const sessions = useUi((s) => s.sessions);
  const openIds = useUi((s) => s.openIds);
  const currentId = useUi((s) => s.currentId);
  const session = useUi((s) => s.session);
  const shellView = useUi((s) => s.shellView);
  const openSession = useUi((s) => s.openSession);
  const closeTab = useUi((s) => s.closeTab);
  const goHome = useUi((s) => s.goHome);

  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'border border-transparent',
          shellView === 'home' && 'border-border bg-surface text-fg',
        )}
        aria-label="最近会话"
        title="最近会话"
        onClick={() => {
          goHome();
        }}
      >
        <HomeIcon />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {openIds.map((id) => {
          const summary = byId.get(id);
          const liveTitle =
            id === currentId && session !== undefined && session.title !== ''
              ? session.title
              : undefined;
          const title = liveTitle ?? summary?.title ?? '会话';
          const active = shellView === 'chat' && currentId === id;
          return (
            <div
              key={id}
              className={cn(
                'session-tab group relative -mb-px flex h-11 max-w-[12rem] shrink-0 items-center',
                'border-b-2',
                active ? 'border-accent' : 'border-transparent',
              )}
            >
              <button
                type="button"
                className={cn(
                  'min-w-0 flex-1 truncate py-1 pl-2.5 text-left transition-colors',
                  active ? 'font-medium text-fg' : 'text-muted hover:text-fg',
                )}
                onClick={() => {
                  void openSession(id);
                }}
              >
                <span className="inline-flex max-w-full items-center">
                  <span className="truncate">{title === '' ? '未命名' : title}</span>
                  {summary !== undefined && <SessionStatusBadge status={summary.status} />}
                </span>
              </button>
              {/*
                关闭键的 hover 底色不能再用 surface-2 —— 那正好是未选中 tab 自己的 hover 底色，
                两者同色时"鼠标已经落在关闭键上"这件事没有任何反馈
              */}
              <button
                type="button"
                className={cn(
                  'mx-1 shrink-0 rounded-chip p-1 text-faint opacity-0 transition',
                  'hover:bg-border hover:text-fg focus-visible:opacity-100 group-hover:opacity-100',
                )}
                aria-label={`关闭 ${title}`}
                title="关闭标签（不删除会话）"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  void closeTab(id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HomeIcon(): ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function CloseIcon(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
