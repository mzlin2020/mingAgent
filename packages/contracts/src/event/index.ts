import { z } from 'zod';
import type { EventId, SessionId, TurnId } from '../base/ids.js';
import { newEventId } from '../base/ids.js';
import { EventEnvelope } from './envelope.js';
import * as P from './payloads.js';
import {
  EVENT_SPECS,
  EXT_EVENT_PREFIX,
  isExtEventType,
  isKnownEventType,
  isPersistedType,
} from './registry.js';
import type { PersistedEventType, XmEventType } from './registry.js';

/**
 * 核心事件的判别联合。
 *
 * 刻意逐条写出而不是从 EVENT_SPECS 生成：生成的写法拿不到"每个 type 对应哪个 payload"
 * 的精确推导，reduce 里就得靠断言，穷尽性检查也就失去意义。这份重复是有回报的。
 */
export const XmEvent = z.discriminatedUnion('type', [
  EventEnvelope.extend({ type: z.literal('session.created'), payload: P.SessionCreatedPayload }),
  EventEnvelope.extend({ type: z.literal('session.renamed'), payload: P.SessionRenamedPayload }),
  EventEnvelope.extend({ type: z.literal('session.configured'), payload: P.SessionConfiguredPayload }),

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
  EventEnvelope.extend({ type: z.literal('usage.recorded'), payload: P.UsagePayload }),
  EventEnvelope.extend({
    type: z.literal('checkpoint.created'),
    payload: P.CheckpointCreatedPayload,
  }),
  EventEnvelope.extend({
    type: z.literal('checkpoint.restored'),
    payload: P.CheckpointRestoredPayload,
  }),
  EventEnvelope.extend({ type: z.literal('notice.posted'), payload: P.NoticePayload }),
  EventEnvelope.extend({ type: z.literal('error.raised'), payload: P.ErrorPayload }),
]);
export type XmEvent = z.infer<typeof XmEvent>;

/** 按 type 取出对应的事件形状，供 reduce 的分支使用 */
export type EventOf<T extends XmEventType> = Extract<XmEvent, { type: T }>;

/** 会落库的那一部分事件。存储端口只认它（见 kernel `port/event-store.ts`）。 */
export type PersistedEvent = Extract<XmEvent, { type: PersistedEventType }>;

export const isPersistedEvent = (e: XmEvent): e is PersistedEvent => isPersistedType(e.type);

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

  /**
   * 来自**更新版本**的事件。
   *
   * 不能沿用"loose 会保留未知字段所以读得下去"的乐观假设：payload 的**语义**可能已经变了
   * （字段含义改写、单位换算、必填变可选）。旧代码按 v1 的理解去读 v2 的数据，
   * 会得到一个看起来正常、实际错误的状态——而且没有任何报错。
   *
   * 这跟未知事件类型是同一类问题，处理方式也必须一样：显式失败。
   */
  if (shell.v > spec.version) {
    throw new Error(
      `事件 "${shell.type}" 的版本 v${String(shell.v)} 高于本机支持的 v${String(spec.version)}` +
        `（seq=${String(shell.seq)}）。该会话由更新版本的小明写入，请升级后再打开——` +
        `降级解释新版本的 payload 会静默产生错误状态。`,
    );
  }

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

/**
 * 写入路径的**唯一**入口。
 *
 * 读取路径（`parseStoredEvent`）从一开始就有校验、有 upcaster、有版本检查；写入路径
 * 却是"手工拼一个对象字面量"——`v` 靠人记得填、payload 靠人记得对。而事件一旦落库
 * 就是永久的：`v` 填错会让日后的 upcaster 跑在错误的数据上，那是**不可逆的污染**，
 * 且要等到几个版本之后才暴露。所以写入侧必须和读取侧一样严。
 *
 * 这里做三件事：
 *   1. `v` 从注册表取，**不接受调用方传入**——这是它存在的首要理由
 *   2. payload 当场按该类型的 schema 校验，写坏的数据进不了库
 *   3. 返回值是判别联合的精确分支，调用点拿到的就是 `EventOf<T>`
 *
 * ── `seq` 的约定（调用方负责，这里无法代劳）──
 *   · persisted 事件传 `nextSeq(state.lastSeq)`
 *   · transient 事件传 `state.lastSeq` 本身——它不落库、不占 seq 空间，
 *     复用上一条持久事件的 seq 只是为了让订阅者知道它挂在哪个位置之后。
 *     用 `durabilityOf(type)` 判断走哪条。
 */
export function createEvent<T extends XmEventType>(input: {
  readonly type: T;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly ts: number;
  readonly payload: EventOf<T>['payload'];
  readonly turnId?: TurnId;
  /** 仅供测试与回放注入；正常写入时留空，由这里生成 */
  readonly id?: EventId;
}): EventOf<T> {
  const spec = EVENT_SPECS[input.type];
  return XmEvent.parse({
    id: input.id ?? newEventId(),
    sessionId: input.sessionId,
    seq: input.seq,
    ts: input.ts,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    type: input.type,
    // 刻意不从 input 取：调用方能填 v，就等于这道校验不存在
    v: spec.version,
    payload: input.payload,
  }) as EventOf<T>;
}

export * from './envelope.js';
export * from './payloads.js';
export * from './registry.js';
