import { z } from 'zod';

/**
 * 任务清单条目。
 *
 * 由模型通过 `todo` 工具自主维护（ADR-0002：单主循环 + todo 工具，替代参考项目
 * 那套硬编码的 Planner 状态机）。UI 把它渲染成进度视图。
 *
 * 契约层不对清单做任何语义约束——不检查"是否只有一个 in_progress"、不检查顺序。
 * 那是提示词该管的事；在这里强加规则只会让模型的合理用法被拒绝。
 */
export const TodoStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const Todo = z.object({
  /** 模型自行分配，会话内唯一即可，不做 UUID 要求 */
  id: z.string().min(1),
  /** 祈使句形式："修复登录超时" */
  content: z.string().min(1),
  status: TodoStatus,
  /** 进行时形式："正在修复登录超时"，供 UI 展示当前动作 */
  activeForm: z.string().optional(),
});
export type Todo = z.infer<typeof Todo>;
