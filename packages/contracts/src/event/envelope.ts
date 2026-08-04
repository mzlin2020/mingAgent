import { z } from 'zod';
import { EventId, SessionId, TurnId } from '../base/ids.js';

/**
 * 事件信封。
 *
 * 🔴 用 `z.looseObject()` 而不是 `z.object()`。Zod 的默认 `z.object()` 是 **strip 模式——
 * 静默丢弃未知字段**，不报错、不告警，数据就那样没了。而在事件流里，未知字段意味着
 * **版本漂移**（新版本写的、旧版本读的），丢弃它等于**永久损坏数据**。
 * 这与"工具入参必须 strictObject"看似矛盾，实则是两个相反的场景，见包 README。
 *
 * ── `seq` 的分配规则（关键不变量）────────────────────────────────
 *
 * 1. 一个会话在同一时刻**只允许一个写者**。会话打开时在 sessions 表上取排他标记
 *    （含进程 PID + 启动时间，用于识别陈旧标记）。
 * 2. `seq` 是会话内单调递增、**无空洞**的整数，从 1 开始。持久化表的
 *    `PRIMARY KEY(session_id, seq)` 天然充当并发写检测——插入冲突即说明有第二个写者，
 *    属于必须立刻崩溃的不变量破坏，**不做重试**。
 * 3. 无空洞是为了让"从 seq N 开始增量订阅"无需任何额外元数据。
 *    UI 重连、CLI attach、评测回放都靠它。
 * 4. **子 Agent 不共享父会话的 seq 空间**：子 Agent 有自己的 sessionId
 *    （sessions.parent_session_id 指回父会话）。这样单写者规则不被并发子 Agent 破坏，
 *    上下文隔离在存储层也是真实的，且子 Agent 的 trace 能被独立回放。
 */
export const EventEnvelope = z.looseObject({
  id: EventId,
  sessionId: SessionId,
  /** 会话内从 1 起递增，无空洞 */
  seq: z.number().int().positive(),
  /** epoch ms。仅供展示与跨会话排序参考，**不是**会话内顺序的依据 */
  ts: z.number().int(),
  /** 归属回合；会话级事件（如 session.title）无此字段 */
  turnId: TurnId.optional(),
  type: z.string(),
  /** 该 type 的 payload 版本，用于 upcaster 逐级升版 */
  v: z.number().int().positive().default(1),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** 持久化层级。见 ADR-0008。 */
export const Durability = z.enum(['persisted', 'transient']);
export type Durability = z.infer<typeof Durability>;
