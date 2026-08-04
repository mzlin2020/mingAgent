import { z } from 'zod';
import { Message } from '../content/message.js';
import { ToolDescriptor } from '../tool/descriptor.js';

/**
 * system prompt 的一段。
 *
 * `cacheable` 是**中立表达**，不是某一家的细节：ContextBuilder 只声明"到这里为止
 * 是稳定的"，Anthropic 适配器翻译成 cache_control，OpenAI 适配器忽略（它自动缓存），
 * Ollama 适配器忽略。如果让 ContextBuilder 直接写 cache_control，内核就绑死了
 * 一家的 wire format。
 */
export const SystemSegment = z.object({
  text: z.string(),
  cacheable: z.boolean().default(false),
});
export type SystemSegment = z.infer<typeof SystemSegment>;

export const ModelRequest = z.object({
  model: z.string(),
  system: z.array(SystemSegment),
  messages: z.array(Message),
  tools: z.array(ToolDescriptor).optional(),
  toolChoice: z
    .union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string() })])
    .optional(),
  maxOutputTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      budgetTokens: z.number().int().positive().optional(),
    })
    .optional(),
  stopSequences: z.array(z.string()).optional(),
  /**
   * 缓存断点：messages 数组的下标，表示"到该条消息为止是稳定前缀"。
   *
   * 配合 ADR-0006 的派生约束——`Tool.available()` 的动态过滤结果不得进入稳定前缀。
   * 具体到这里：`tools` 数组若逐轮变化，system 的 cacheable 段仍可缓存，
   * 但本断点必须置于工具列表变化点之后，否则缓存每轮全失效。
   */
  cacheBreakpointAfterMessage: z.number().int().nonnegative().optional(),
});
export type ModelRequest = z.infer<typeof ModelRequest>;
