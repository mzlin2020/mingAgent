import type { ReactNode } from 'react';
import type { Checkpoint } from '@xm/kernel';
import type { Todo } from '@xm/contracts';
import { CheckpointPanel } from './checkpoint-panel.js';
import { LiveCalls } from './live-views.js';
import { TerminalPanel } from './terminal-panel.js';
import { TodoPanel } from './todo-panel.js';

export function WorkbenchPanel({
  sessionId,
  todos,
  checkpoints,
  open,
}: {
  readonly sessionId: string;
  readonly todos: readonly Todo[];
  readonly checkpoints: readonly Checkpoint[];
  readonly open: boolean;
}): ReactNode {
  return (
    <aside
      className="workspace-panel shrink-0"
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      aria-label="任务工作区"
    >
      <div className="workspace-panel__inner flex h-full flex-col bg-surface">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3.5">
          <div>
            <div className="font-medium">工作区</div>
            <div className="text-micro text-muted">进度、命令与文件恢复</div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-3">
            <TodoPanel todos={todos} />
            <LiveCalls />
            <TerminalPanel />
            <CheckpointPanel sessionId={sessionId} checkpoints={checkpoints} />
          </div>
        </div>
      </div>
    </aside>
  );
}
