import { z } from 'zod';
import { BlobRef } from '../base/blob.js';
import { CallId } from '../base/ids.js';

/**
 * 能出现在**工具结果**里的块。刻意不含 tool_use / tool_result。
 *
 * 为什么要这个子集：递归类型在 Zod 里要用 `z.lazy()`，而 z.lazy 导出的 JSON Schema
 * 带 `$ref`，跨进程传输与喂给模型时都会掉坑（各家对 $ref 的支持参差）。
 * 用非递归子集把问题从根上消掉——工具结果里嵌套工具调用本来也没有语义。
 */
export const ResultBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), source: BlobRef }),
  z.object({ type: z.literal('document'), source: BlobRef }),
]);
export type ResultBlock = z.infer<typeof ResultBlock>;

/**
 * 消息内容块全集。形状对齐 Anthropic 的 wire format——不是因为要绑定某一家，
 * 而是因为它的块模型表达力最强：从块模型拆成 OpenAI 那种扁平结构容易，反过来难。
 * 各家适配器负责在边界上翻译。
 */
export const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), source: BlobRef }),
  z.object({ type: z.literal('document'), source: BlobRef }),

  /**
   * 思考块。`signature` 必须原样回传，否则开启扩展思考后的多轮工具调用会被模型侧拒绝。
   */
  z.object({
    type: z.literal('thinking'),
    text: z.string(),
    signature: z.string().optional(),
  }),

  /**
   * 加密的思考块。看起来像某一家的私有细节，但**第一天就必须在**：
   * 漏了它会导致开启扩展思考后的多轮工具调用整体失败，且报错信息晦涩到无法定位。
   * （参考项目连普通 thinking 都没有。）
   */
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),

  /**
   * `input` 是 z.unknown()：契约层不知道具体工具的入参形状，校验发生在
   * ToolRegistry 拿到工具自己的 schema 之后。这里若写成 z.record() 就等于强加
   * "入参必须是对象"——大部分是，但不该由契约层规定。
   */
  z.object({ type: z.literal('tool_use'), id: CallId, name: z.string(), input: z.unknown() }),

  z.object({
    type: z.literal('tool_result'),
    toolUseId: CallId,
    content: z.array(ResultBlock),
    isError: z.boolean(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** 便捷构造：绝大多数工具结果就是一段文本 */
export const textResult = (text: string): ResultBlock[] => [{ type: 'text', text }];
