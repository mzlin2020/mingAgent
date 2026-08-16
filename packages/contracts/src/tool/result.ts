import { z } from 'zod';
import { ResultBlock } from '../content/block.js';

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
   * 结果里最多保留几个非文本块（图片 / 文档）。
   *
   * `maxBytes` 只约束文本，而一张截图进上下文的代价是上千 token——浏览器自动化和
   * computer use（M4）一次返回十几张截图是完全正常的用法，不设上限就是"文本抠着算，
   * 图片随便塞"。超出的块被丢弃并在文本标记里说明丢了几个，同样对模型可见。
   */
  maxBlocks: z.number().int().nonnegative().default(4),
  /**
   * 默认 `middle`：头尾都保留。命令输出的头部有上下文、尾部有错误信息，中间往往是噪音。
   * `head`/`tail` 留给明确知道信息分布的工具。
   */
  strategy: z.enum(['head', 'tail', 'middle', 'none']).default('middle'),
});
export type ResultLimits = z.infer<typeof ResultLimits>;

export const DEFAULT_RESULT_LIMITS: ResultLimits = {
  maxBytes: 64 * 1024,
  maxBlocks: 4,
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
    /**
     * 回放需要的**最小事实**，随 `tool.end` 落库（ADR-0058 的 `presentationMeta`）。
     *
     * 为什么是工具 yield 出来的一个字段，而不是描述符上的第三个投影函数：
     * 它**不需要是纯函数**——只在结果时刻求值一次、输出落库、回放时从库里读回来。
     * 做成 `presentationMeta(args, value)` 反而要求先发明 `docs/10 §9.5.4` 的规范输出值
     * 把执行期事实喂给它，而那是 M3-h 的范围。见 ADR-0058 的 2026-08-15 定案。
     *
     * 形状由工具自己的 Zod schema（`ToolSpec.presentationSchema`）校验；
     * 它是**回放期投影函数唯一的输入来源之一**，所以宁可小、宁可自足，
     * 不要把渲染顺手用得上的东西全塞进来——那正是 `DisplayHint.data` 全量落库的老毛病。
     */
    presentation: z.unknown().optional(),
    /**
     * **规范输出值**（`docs/10 §9.5.4`，ADR-0071）：这次调用产生的、程序可用的结构化事实。
     *
     * 与同一个分支上另外两个字段的分工是刻意的三分：
     *
     * | 字段 | 给谁看 | 落不落库 |
     * |---|---|---|
     * | `forModel` | 模型（散文，会被截断） | 落 |
     * | `presentation` | 回放期的卡片投影 | 落 |
     * | `output` | **程序**（Code Mode 的子调用返回值） | **不落** |
     *
     * 不落库不是省事，是因为它与前两者**大量重复且体积不受控**：`fs.read` 的规范值里
     * 带着文件正文，`shell.exec` 带着完整 stdout。把它写进事件流等于把同一份内容存两遍，
     * 而这正是 ADR-0050 / ADR-0070 已经修过两次的那个形状。**它也不需要落库**——
     * "模型可见 ⟺ 已落库"约束的是进入模型请求的东西，而规范值按定义不进模型请求
     * （ADR-0061 §四：程序中间值不落库、不进提示词、不受结果截断管辖）。
     *
     * 形状由工具自己的 `ToolSpec.outputSchema` 校验，**没声明就不产出**（失败关闭），
     * 与 `presentation` 同一个形状同一个理由。
     */
    output: z.unknown().optional(),
  }),
]);
export type ToolProgress = z.infer<typeof ToolProgress>;
