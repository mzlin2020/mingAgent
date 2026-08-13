import { useState, type ReactNode } from 'react';
import type { Todo } from '@xm/contracts';
import { shouldShowTodoPanel, todoDisplayText, todoProgress } from '../lib/todo-progress.js';
import { cn } from '../lib/cn.js';
import { Card } from './ui.js';

const STATUS_MARK: Record<Todo['status'], string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
};

export function TodoPanel({ todos }: { readonly todos: readonly Todo[] }): ReactNode {
  const [showCompleted, setShowCompleted] = useState(false);
  if (!shouldShowTodoPanel(todos)) return null;
  const progress = todoProgress(todos);
  const allCompleted = progress.completed === progress.total;
  const showItems = !allCompleted || showCompleted;

  return (
    <Card className="p-0" tone={allCompleted ? 'default' : 'accent'}>
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="font-medium">任务清单</span>
        <span className="flex items-center gap-2 text-meta text-muted">
          {progress.completed}/{progress.total} 已完成
          {allCompleted && (
            <button
              type="button"
              className="text-muted hover:text-fg"
              aria-expanded={showCompleted}
              onClick={() => { setShowCompleted((value) => !value); }}
            >
              {showCompleted ? '收起' : '查看'}
            </button>
          )}
        </span>
      </div>
      {showItems && (
        <ul className="ui-expand flex flex-col py-1" aria-label="任务清单">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-2.5 px-3.5 py-1.5">
              <span
                className={cn(
                  'mt-0.5 shrink-0 font-mono text-meta',
                  todo.status === 'in_progress' && 'text-accent',
                  todo.status === 'completed' && 'text-faint',
                  todo.status === 'pending' && 'text-muted',
                )}
                aria-hidden="true"
              >
                {STATUS_MARK[todo.status]}
              </span>
              <span
                className={cn(
                  'min-w-0 text-body',
                  todo.status === 'completed' && 'text-faint line-through',
                  todo.status === 'in_progress' && 'font-medium',
                )}
              >
                {todoDisplayText(todo)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
