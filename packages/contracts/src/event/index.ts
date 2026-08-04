import { z } from 'zod';
import { EventEnvelope } from './envelope.js';
import * as P from './payloads.js';
import { EVENT_SPECS, EXT_EVENT_PREFIX, isExtEventType, isKnownEventType } from './registry.js';
import type { XmEventType } from './registry.js';

/**
 * 核心事件的判别联合。
 *
 * 刻意逐条写出而不是从 EVENT_SPECS 生成：生成的写法拿不到"每个 type 对应哪个 payload"
 * 的精确推导，reduce 里就得靠断言，穷尽性检查也就失去意义。这份重复是有回报的。
 */
export const XmEvent = z.discriminatedUnion('type', [
  EventEnvelope.extend({ type: z.literal('session.created'), payload: P.SessionCreatedPayload }),
  EventEnvelope.extend({ type: z.literal('session.title'), payload: P.SessionTitlePayload }),
  EventEnvelope.extend({ type: z.literal('session.config'), payload: P.SessionConfigPayload }),

  EventEnvelope.extend({ type: z.literal('turn.start'), payload: P.TurnStartPayload }),
  EventEnvelope.extend({ type: z.literal('turn.end'), payload: P.TurnEndPayload }),

  EventEnvelope.extend({ type: z.literal('message.start'), payload: P.MessageStartPayload }),
  EventEnvelope.extend({ type: z.literal('message.delta'), payload: P.MessageDeltaPayload }),
  EventEnvelope.extend({ type: z.literal('message.end'), payload: P.MessageEndPayload }),
  EventEnvelope.extend({
    type: z.literal('message.interrupted'),
    payload: P.MessageInterruptedPayload,
  }),

  EventEnvelope.extend({ type: z.literal('tool.start'), payload: P.ToolStartPayload }),
  EventEnvelope.extend({ type: z.literal('tool.progress'), payload: P.ToolProgressPayload }),
  EventEnvelope.extend({ type: z.literal('tool.end'), payload: P.ToolEndPayload }),

  EventEnvelope.extend({
    type: z.literal('permission.request'),
    payload: P.PermissionRequestPayload,
  }),
  EventEnvelope.extend({
    type: z.literal('permission.decision'),
    payload: P.PermissionDecisionPayload,
  }),

  EventEnvelope.extend({ type: z.literal('todo.updated'), payload: P.TodoUpdatedPayload }),
  EventEnvelope.extend({ type: z.literal('subagent.start'), payload: P.SubagentStartPayload }),
  EventEnvelope.extend({ type: z.literal('subagent.end'), payload: P.SubagentEndPayload }),

  EventEnvelope.extend({
    type: z.literal('context.compacted'),
    payload: P.ContextCompactedPayload,
  }),
  EventEnvelope.extend({ type: z.literal('usage'), payload: P.UsagePayload }),
  EventEnvelope.extend({
    type: z.literal('checkpoint.created'),
    payload: P.CheckpointCreatedPayload,
  }),
  EventEnvelope.extend({
    type: z.literal('checkpoint.restored'),
    payload: P.CheckpointRestoredPayload,
  }),
  EventEnvelope.extend({ type: z.literal('notice'), payload: P.NoticePayload }),
  EventEnvelope.extend({ type: z.literal('error'), payload: P.ErrorPayload }),
]);
export type XmEvent = z.infer<typeof XmEvent>;

/** 按 type 取出对应的事件形状，供 reduce 的分支使用 */
export type EventOf<T extends XmEventType> = Extract<XmEvent, { type: T }>;

/** 插件自定义事件。核心不解释它的 payload。 */
export const ExtEvent = EventEnvelope.extend({
  type: z.string().startsWith(EXT_EVENT_PREFIX),
  payload: z.unknown(),
});
export type ExtEvent = z.infer<typeof ExtEvent>;

/** 事件总线上流动的一切 */
export type AnyEvent = XmEvent | ExtEvent;

export const isCoreEvent = (e: AnyEvent): e is XmEvent => isKnownEventType(e.type);

/**
 * 读取路径：先按存储的 `v` 逐级升到当前版本，再全量校验。
 *
 * 未知类型（既不在注册表里，也不是 `ext.*`）会抛出——这通常意味着数据来自
 * 更新版本的小明，静默忽略会让状态悄悄错掉，不如显式失败。
 */
export function parseStoredEvent(row: unknown): AnyEvent {
  const shell = EventEnvelope.parse(row);

  if (isExtEventType(shell.type)) {
    return ExtEvent.parse(shell);
  }

  if (!isKnownEventType(shell.type)) {
    throw new Error(
      `未知事件类型 "${shell.type}"（seq=${String(shell.seq)}）。` +
        `多半是该会话由更新版本的小明写入。请升级后再打开。`,
    );
  }

  const spec = EVENT_SPECS[shell.type];
  let payload = shell.payload;

  for (let v = shell.v; v < spec.version; v++) {
    const up: ((old: unknown) => unknown) | undefined = (
      spec as { upcasters?: Record<number, (old: unknown) => unknown> }
    ).upcasters?.[v];
    if (up === undefined) {
      throw new Error(
        `事件 "${shell.type}" 缺少 v${String(v)} → v${String(v + 1)} 的 upcaster。` +
          `改版本号时必须同时提供升级函数（ADR-0008）。`,
      );
    }
    payload = up(payload);
  }

  return XmEvent.parse({ ...shell, v: spec.version, payload });
}

export * from './envelope.js';
export * from './payloads.js';
export * from './registry.js';
