import { z } from 'zod';
import { CallId } from '../base/ids.js';
import { StopReason, Usage } from './usage.js';

/**
 * 流式响应块（各家适配器归一化后的中立形状）。
 *
 * `tool_call_delta.argsJson` 是**增量 JSON 字符串片段**——不要试图在契约层解析：
 * 各家的分片边界不同，累积完整后再一次性 parse 是唯一稳妥做法。
 * 累积器放在 kernel，配套一个"JSON 不完整"的明确错误码（invalid_input）。
 */
export const ModelChunk = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text_delta'), text: z.string() }),
  z.object({ kind: z.literal('thinking_delta'), text: z.string() }),
  z.object({ kind: z.literal('thinking_signature'), signature: z.string() }),
  z.object({ kind: z.literal('tool_call_start'), id: CallId, name: z.string() }),
  z.object({ kind: z.literal('tool_call_delta'), id: CallId, argsJson: z.string() }),
  z.object({ kind: z.literal('tool_call_end'), id: CallId }),
  z.object({ kind: z.literal('usage'), usage: Usage }),
  z.object({ kind: z.literal('stop'), reason: StopReason }),
]);
export type ModelChunk = z.infer<typeof ModelChunk>;
