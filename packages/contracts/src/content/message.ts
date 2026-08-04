import { z } from 'zod';
import { MessageId } from '../base/ids.js';
import { ContentBlock } from './block.js';

/**
 * **只有两个 role。**
 *
 * 工具结果作为 `tool_result` 块放进 `user` 消息——这与 Anthropic 的 wire format 一致，
 * 是我们中立层的形状。OpenAI 适配器负责把它拆成独立的 `tool` role 消息。
 *
 * system prompt **不是** Message：它由 ContextBuilder 组装成 SystemSegment[]
 * （见 model/request.ts），因为它要携带缓存断点信息，而普通消息不需要。
 */
export const Role = z.enum(['user', 'assistant']);
export type Role = z.infer<typeof Role>;

export const Message = z.object({
  id: MessageId,
  role: Role,
  blocks: z.array(ContentBlock),
  /** assistant 消息记录来自哪个模型；换模型后回看历史时这是关键信息 */
  model: z.string().optional(),
  /** 计算后缓存，用于上下文预算。不是真相，只是避免反复 count */
  tokens: z.number().int().optional(),
  ts: z.number().int(),
});
export type Message = z.infer<typeof Message>;
