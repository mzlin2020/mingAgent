import { z } from 'zod';
import { ResultBlock } from '../content/block.js';
import { DisplayHint } from './display.js';

/**
 * 结果截断上限。**由运行时统一执行，不由工具自觉。**
 *
 * 工具返回全量，运行时按此截断、把全文写进 blob、在截断处插入**对模型可见**的标记。
 * 悄悄截断是最坏的做法——模型会基于残缺内容自信地下结论，而且这种错误极难归因。
 */
export const ResultLimits = z.object({
  maxBytes: z.number().int().positive().default(64 * 1024),
  maxLines: z.number().int().positive().optional(),
  /**
   * 默认 `middle`：头尾都保留。命令输出的头部有上下文、尾部有错误信息，中间往往是噪音。
   * `head`/`tail` 留给明确知道信息分布的工具。
   */
  strategy: z.enum(['head', 'tail', 'middle', 'none']).default('middle'),
});
export type ResultLimits = z.infer<typeof ResultLimits>;

export const DEFAULT_RESULT_LIMITS: ResultLimits = {
  maxBytes: 64 * 1024,
  strategy: 'middle',
};

/**
 * 工具执行期间推给运行时的流。
 * `progress` 是瞬态的（不落库），`result` 是终态。
 */
export const ToolProgress = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('progress'),
    message: z.string().optional(),
    data: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('result'),
    forModel: z.array(ResultBlock),
    display: DisplayHint.optional(),
  }),
]);
export type ToolProgress = z.infer<typeof ToolProgress>;
