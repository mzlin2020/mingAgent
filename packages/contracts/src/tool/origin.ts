import { z } from 'zod';
import { CallId } from '../base/ids.js';

/**
 * 这次调用是谁发起的（ADR-0065 §四）。默认 `model`。
 *
 * 有了它，审计才能回答"这次写入是模型自己要写的，还是用户在某张卡片上点出来的"——
 * 退役掉的 `edit-review` 专用通道产生的写入在事件流里看不出这个区别，
 * 这是它退役时应当顺手补上的一课。
 *
 * ⚠️ `user-action` **不是一档更高的信任级别**。被接受的内容仍然是模型产出的
 * （diff 的每一行都来自模型），`trustLevel` 按内容来源算、不按谁点的算，
 * 污点照常传播（ADR-0033 / ADR-0045）。它只回答"谁按的"，不回答"该不该放行"。
 */
export const ToolCallOrigin = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('model') }),
  z.looseObject({
    kind: z.literal('user-action'),
    /** 承载这张卡片的那次调用 */
    fromCallId: CallId,
    actionId: z.string(),
  }),
]);
export type ToolCallOrigin = z.infer<typeof ToolCallOrigin>;
