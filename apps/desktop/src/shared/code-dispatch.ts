import { z } from 'zod';
import { CallId, XmError } from '@xm/contracts';

/**
 * 渲染层看到的一条 Code Mode 子调用（ADR-0072）。
 *
 * 字段是 `tool.code.dispatch` payload 的**显式子集**：`callId` / 入参 / 成败 / 失败原因。
 * **没有 `forModel`。** 那条事件的 schema 里本来就没有这个位置；就算有人在投影时
 * 把一份结果正文塞进来，这里也不会收下——详情栏的 Output 因此结构性地拿不到
 * 程序中间值。那是设计（中间值不进提示词），不是数据缺失。
 */
export const CodeDispatchView = z.object({
  callId: CallId,
  parentCallId: CallId,
  index: z.number().int().nonnegative(),
  name: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  error: XmError.optional(),
});
export type CodeDispatchView = z.infer<typeof CodeDispatchView>;

/**
 * 从一条 dispatch payload 抽出详情要用的字段。
 *
 * 入参允许带多余键（包括有人硬编的 `forModel`）：构造时只抄上面那张表，
 * 多出来的键进不了返回值。
 */
export function toDispatchView(payload: {
  readonly callId: CodeDispatchView['callId'];
  readonly parentCallId: CodeDispatchView['parentCallId'];
  readonly index: number;
  readonly name: string;
  readonly input: unknown;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: XmError | undefined;
  readonly forModel?: unknown;
}): CodeDispatchView {
  return CodeDispatchView.parse({
    callId: payload.callId,
    parentCallId: payload.parentCallId,
    index: payload.index,
    name: payload.name,
    input: payload.input,
    ok: payload.ok,
    durationMs: payload.durationMs,
    ...(payload.error === undefined ? {} : { error: payload.error }),
  });
}
