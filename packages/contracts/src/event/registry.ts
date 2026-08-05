import type { z } from 'zod';
import type { Durability } from './envelope.js';
import * as P from './payloads.js';

/**
 * 事件类型注册表：类型 → { schema, 持久化层级, 当前版本, upcaster }。
 *
 * `durability` 是**静态标注**，因为持久化包含性测试（ADR-0008）需要在不跑真实会话的
 * 前提下就能把事件流拆成两份。运行时判断会让那个测试失去意义。
 */
export interface EventSpec {
  schema: z.ZodType;
  durability: Durability;
  /** 当前 payload 版本 */
  version: number;
  /**
   * 版本升级函数：`upcasters[n]` 把 v=n 的 payload 升到 v=n+1。
   *
   * 演进规则（ADR-0008）：
   *   · 加**可选**字段 → version 不变（老数据 parse 通过，新数据老代码忽略多余字段）
   *   · 加必填字段 / 改字段语义 / 删字段 → version 加一，**且必须提供 upcaster**
   */
  upcasters?: Record<number, (old: unknown) => unknown>;
}

export const EVENT_SPECS = {
  // ── 会话 ──
  'session.created': { schema: P.SessionCreatedPayload, durability: 'persisted', version: 1 },
  'session.renamed': { schema: P.SessionRenamedPayload, durability: 'persisted', version: 1 },
  'session.configured': { schema: P.SessionConfiguredPayload, durability: 'persisted', version: 1 },

  // ── 回合 ──
  'turn.start': { schema: P.TurnStartPayload, durability: 'persisted', version: 1 },
  'turn.end': { schema: P.TurnEndPayload, durability: 'persisted', version: 1 },

  // ── 模型消息 ──
  'message.start': { schema: P.MessageStartPayload, durability: 'persisted', version: 1 },
  'message.delta': { schema: P.MessageDeltaPayload, durability: 'transient', version: 1 },
  'message.end': { schema: P.MessageEndPayload, durability: 'persisted', version: 1 },
  'message.interrupted': {
    schema: P.MessageInterruptedPayload,
    durability: 'persisted',
    version: 1,
  },

  // ── 工具 ──
  'tool.start': { schema: P.ToolStartPayload, durability: 'persisted', version: 1 },
  'tool.progress': { schema: P.ToolProgressPayload, durability: 'transient', version: 1 },
  'tool.end': { schema: P.ToolEndPayload, durability: 'persisted', version: 1 },

  // ── 权限 ──
  'permission.request': { schema: P.PermissionRequestPayload, durability: 'persisted', version: 1 },
  'permission.decision': {
    schema: P.PermissionDecisionPayload,
    durability: 'persisted',
    version: 1,
  },

  'trust.cleared': { schema: P.TrustClearedPayload, durability: 'persisted', version: 1 },

  // ── 任务与子 Agent ──
  'todo.updated': { schema: P.TodoUpdatedPayload, durability: 'persisted', version: 1 },
  'subagent.start': { schema: P.SubagentStartPayload, durability: 'persisted', version: 1 },
  'subagent.end': { schema: P.SubagentEndPayload, durability: 'persisted', version: 1 },

  // ── 上下文与运维 ──
  'context.compacted': { schema: P.ContextCompactedPayload, durability: 'persisted', version: 1 },
  'usage.recorded': { schema: P.UsagePayload, durability: 'persisted', version: 1 },
  'checkpoint.created': { schema: P.CheckpointCreatedPayload, durability: 'persisted', version: 1 },
  'checkpoint.restored': {
    schema: P.CheckpointRestoredPayload,
    durability: 'persisted',
    version: 1,
  },
  'notice.posted': { schema: P.NoticePayload, durability: 'persisted', version: 1 },
  'error.raised': { schema: P.ErrorPayload, durability: 'persisted', version: 1 },
} as const satisfies Record<string, EventSpec>;

export type XmEventType = keyof typeof EVENT_SPECS;

/**
 * 会落库的事件类型，**从 `durability` 标注推导**而来。
 *
 * 有了它，"瞬态事件不得写入 EventStore" 就从一条注释变成编译期错误：
 * `SessionWriter.append` 只接受 `PersistedEvent`，把 `message.delta` 递进去直接不过编译。
 * 这条约束以前只靠 `tests/persistence-containment.test.ts` 在事后拦，
 * 现在写入侧当场就拦得住。
 */
export type PersistedEventType = {
  [K in XmEventType]: (typeof EVENT_SPECS)[K]['durability'] extends 'persisted' ? K : never;
}[XmEventType];

export const ALL_EVENT_TYPES = Object.keys(EVENT_SPECS) as XmEventType[];

export const isKnownEventType = (t: string): t is XmEventType =>
  Object.hasOwn(EVENT_SPECS, t) && !t.startsWith(EXT_EVENT_PREFIX);

export const durabilityOf = (t: XmEventType): Durability => EVENT_SPECS[t].durability;

export const isPersistedType = (t: XmEventType): boolean => durabilityOf(t) === 'persisted';

/** 落库的事件类型全集。持久化包含性测试用它把完整流拆成两份。 */
export const PERSISTED_EVENT_TYPES: readonly XmEventType[] = ALL_EVENT_TYPES.filter(isPersistedType);

export const TRANSIENT_EVENT_TYPES: readonly XmEventType[] = ALL_EVENT_TYPES.filter(
  (t) => !isPersistedType(t),
);

/**
 * 插件自定义事件的前缀。
 *
 * 核心**不校验** `ext.*` 的 payload（由插件清单里声明的 schema 在插件宿主边界校验），
 * 核心的 reducer 一律忽略它们，只转发给订阅了该插件的渲染器。
 *
 * **核心状态永远不依赖扩展事件**——否则删掉插件就无法 reduce 历史会话，直接违反原则二。
 */
export const EXT_EVENT_PREFIX = 'ext.';

export const isExtEventType = (t: string): boolean => t.startsWith(EXT_EVENT_PREFIX);
