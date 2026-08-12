import type { Todo } from '@xm/contracts';

export interface TodoProgress {
  readonly completed: number;
  readonly total: number;
}

export function todoProgress(todos: readonly Todo[]): TodoProgress {
  return {
    completed: todos.filter((todo) => todo.status === 'completed').length,
    total: todos.length,
  };
}

export function shouldShowTodoPanel(todos: readonly Todo[]): boolean {
  return todos.length > 0;
}

export function todoDisplayText(todo: Todo): string {
  return todo.status === 'in_progress' && todo.activeForm !== undefined
    ? todo.activeForm
    : todo.content;
}
