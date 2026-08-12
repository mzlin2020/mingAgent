import { z } from 'zod';
import type { SessionId, Todo, ToolProgress } from '@xm/contracts';
import { TodoInput } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { ToolInputError, defineTool } from '@xm/kernel';

export const TODO_UPDATE = 'todo.update';

const MAX_TODOS = 100;

const Input = z.strictObject({
  todos: z
    .array(TodoInput)
    .max(MAX_TODOS)
    .describe('任务清单的完整快照；传空数组表示清空清单'),
});

export interface TodoUpdate {
  readonly sessionId: SessionId;
  readonly todos: readonly Todo[];
}

export type TodoUpdater = (update: TodoUpdate) => Promise<void>;

/**
 * 会话任务清单工具（ADR-0041）。
 *
 * updater 只能接收 sessionId + todos，刻意不是 `runtime.record`。这样工具没有写入
 * `trust.cleared` 等任意事件的能力，`ToolContext` 也继续保持无事件入口。
 */
export const todoUpdateTool = (updater: TodoUpdater): RegisteredTool =>
  defineTool({
    name: TODO_UPDATE,
    group: 'todo',
    description:
      '用完整快照更新当前会话的任务清单。适合至少三个实质步骤的任务；简单任务不要创建清单。' +
      '每次状态或顺序变化都要重新提交完整 todos，传空数组可清空。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: [],
    concurrency: 'exclusive',
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const duplicate = duplicateId(input.todos);
      if (duplicate !== undefined) {
        throw new ToolInputError(TODO_UPDATE, `todo id "${duplicate}" 重复；id 必须在会话内唯一。`);
      }

      await updater({ sessionId: ctx.sessionId, todos: input.todos });

      const completed = input.todos.filter((todo) => todo.status === 'completed').length;
      yield {
        kind: 'result',
        forModel: [
          {
            type: 'text',
            text:
              input.todos.length === 0
                ? '任务清单已清空。'
                : `任务清单已更新：${String(completed)}/${String(input.todos.length)} 已完成。`,
          },
        ],
      };
    },
  });

function duplicateId(todos: readonly Todo[]): string | undefined {
  const seen = new Set<string>();
  for (const todo of todos) {
    if (seen.has(todo.id)) return todo.id;
    seen.add(todo.id);
  }
  return undefined;
}

