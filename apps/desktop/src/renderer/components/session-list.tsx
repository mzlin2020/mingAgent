import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

export function SessionList(): ReactNode {
  const { sessions, currentId } = useUi();
  const newSession = useUi((s) => s.newSession);
  const openSession = useUi((s) => s.openSession);
  const chooseWorkspace = useUi((s) => s.chooseWorkspace);

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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-[var(--xm-fg-muted)]">还没有会话</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            onClick={() => void openSession(s.sessionId)}
            className={cn(
              'mb-1 w-full truncate rounded-md px-2 py-1.5 text-left text-sm',
              s.sessionId === currentId
                ? 'bg-[var(--xm-surface)] font-medium'
                : 'text-[var(--xm-fg-muted)] hover:bg-[var(--xm-surface)]',
            )}
          >
            {s.title ?? '未命名'}
          </button>
        ))}
      </div>
    </aside>
  );
}
