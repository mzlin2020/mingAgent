import { describe, expect, it } from 'vitest';
import type { Todo } from '@xm/contracts';
import {
  shouldShowTodoPanel,
  todoDisplayText,
  todoProgress,
} from '../src/renderer/lib/todo-progress.js';

describe('任务清单进度视图', () => {
  const todos: readonly Todo[] = [
    { id: 'a', content: '已完成项', status: 'completed' },
    { id: 'b', content: '实现功能', activeForm: '正在实现功能', status: 'in_progress' },
    { id: 'c', content: '待办项', status: 'pending' },
  ];

  it('只把 completed 计入完成数', () => {
    expect(todoProgress(todos)).toEqual({ completed: 1, total: 3 });
    expect(todoProgress([])).toEqual({ completed: 0, total: 0 });
  });

  it('空清单不显示面板，避免默认界面噪音', () => {
    expect(shouldShowTodoPanel([])).toBe(false);
    expect(shouldShowTodoPanel(todos)).toBe(true);
  });

  it('进行中优先显示 activeForm，其余状态显示 content', () => {
    expect(todoDisplayText(todos[1]!)).toBe('正在实现功能');
    expect(todoDisplayText(todos[0]!)).toBe('已完成项');
  });
});
