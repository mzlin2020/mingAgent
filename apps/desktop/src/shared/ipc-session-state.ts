import { z } from 'zod';
import {
  AgentId,
  BlobRef,
  CallId,
  Capability,
  CheckpointId,
  ConfigPatch,
  Message,
  MessageId,
  PermissionRequest,
  PtySessionId,
  RequestId,
  SessionId,
  Todo,
  TurnId,
  Usage,
  XmError,
} from '@xm/contracts';

/**
 * 会话状态的可过 IPC 镜像（ADR-0032，修 G4/G5）。
 *
 * 从 `shared/ipc.ts` 拆出来的独立文件——纯粹是规模纪律（docs/01 原则七，ADR-0032）：
 * 这一块本身是自足的（只服务 `readSession` 这一条 IPC），拆出来不影响任何调用点，
 * `ipc.ts` 用 `export *` 把这里的导出原样接上，消费方（`services.ts`/`bridge.ts`/
 * 测试）继续从 `shared/ipc.js` 导入，不知道也不需要知道这条分界线的存在。
 *
 * ── 为什么不再是"整段事件数组"（`z.array(EventEnvelope)`）──
 *
 * 旧形状要求渲染层拿到全部历史事件后自己 `reduce()` 一遍——这在一个用了几个月、
 * 几万条事件的会话上会把主进程的 `structuredClone` 和渲染层的回放都卡到几百毫秒
 * （docs/09 G5 实测：5 万事件 685ms，两个进程各卡一次）。而主进程这时早就有一份
 * 现成的、已经 `reduce()` 过的 `SessionRuntime.state`——`readSession` 现在直接把
 * 它序列化过去，渲染层只做 `deserializeSessionState()`，不再重新回放历史。
 *
 * 这**没有**违反"渲染层不维护第二份状态"（ADR-0015）：状态仍然只有一处计算——
 * 主进程的 `reduce()`——渲染层只是消费结果，不再重复计算一遍。真正体现
 * "内核能在浏览器里跑"的场景（后续每一条实时事件）不受影响，渲染层照样对
 * 每条新事件调用 `reduce()`（见 `store.ts` 的 `applyEvent`），只有"打开会话时
 * replay 全部历史"这一次性的、纯粹昂贵的动作被挪到了主进程侧，且主进程本来就
 * 要维护这份状态（`runtimeFor()` 缓存的 `SessionRuntime` 实例），不是新增计算。
 *
 * ── 为什么不做深度 strict 校验 ──
 *
 * 这份数据始终是"主进程 → 渲染层"单向流动，且生产方（`serializeSessionState`）
 * 与消费方（`deserializeSessionState`）是同一份 `@xm/kernel` 代码——不存在
 * "渲染层需要提防主进程撒谎"这件事（真正需要提防的方向是反过来）。这里的字段级
 * schema 与 `EventEnvelope` 的"松"是同一个理由：**收益是版本一致性，不是安全**
 * （开发时热重载让两侧代码错开的那类问题），所以复合字段用 `z.unknown()`
 * 兜底而不是逐层展开每一种 `ContentBlock`/工具输入——那些已经在事件层校验过一次。
 */
const PermissionGrantSchema = z.object({
  requestId: RequestId,
  capability: Capability,
  target: z.string(),
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['session', 'always']),
  ts: z.number(),
});

const UntrustedContextSchema = z.object({
  callId: CallId,
  toolName: z.string(),
  viaCapability: Capability,
  since: z.number(),
});

const RunningCallSchema = z.object({
  callId: CallId,
  name: z.string(),
  startedAt: z.number(),
  // 崩溃恢复要能合成结构化中断结果，见 kernel/state/session-state.ts 的 RunningCall
  messageId: MessageId,
  input: z.unknown(),
});
const RunningSubagentSchema = z.object({
  agentId: AgentId,
  childSessionId: SessionId,
  purpose: z.string(),
  startedAt: z.number(),
});
const OpenPtySessionSchema = z.object({ ptySessionId: PtySessionId, cwd: z.string(), startedAt: z.number() });
const NoticeSchema = z.object({
  level: z.enum(['info', 'warn']),
  code: z.string(),
  message: z.string(),
  ts: z.number(),
});
const CheckpointSchema = z.object({
  checkpointId: CheckpointId,
  kind: z.enum(['fs', 'git']),
  ref: z.string(),
  label: z.string(),
  restoredAt: z.number().or(z.undefined()),
});
const CompactionSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
  summaryRef: BlobRef,
  tokensBefore: z.number(),
  tokensAfter: z.number(),
});
const UsageTotalsSchema = z.object({
  usage: Usage,
  costUsd: z.number(),
  turns: z.number(),
  unpricedTurns: z.number(),
});

/*
 * 下面这批可选字段一律用 `.or(z.undefined())` 而不是 `.optional()`——
 * 两者在 zod 里推出的 TS 类型不同：`.optional()` 让**键**变成可选
 * （`x?: T`），`.or(z.undefined())` 让键保持必填、只是值允许是
 * `undefined`（`x: T | undefined`）。`SerializedSessionState`（`@xm/kernel`）
 * 和它照抄的 `SessionState` 一样，字段全部写成后一种形状（原因见
 * `session-state.ts` 顶部注释：`exactOptionalPropertyTypes` 下 `x?: X`
 * 没法用 `{ ...state, x: undefined }` 清空）。这里选错一个，
 * `deserializeSessionState()` 的入参类型就对不上，会在类型层面被迫走
 * `as` 绕过去——那正是这条约定原本要防的事。
 */
export const SerializedSessionStateResult = z.object({
  id: SessionId,
  title: z.string(),
  cwd: z.string(),
  modelRef: z.string(),
  status: z.enum(['idle', 'running', 'waiting_permission', 'error']),
  messages: z.array(Message),
  activeTurn: z.object({ turnId: TurnId, startedAt: z.number() }).or(z.undefined()),
  activeMessage: z
    .object({
      messageId: MessageId,
      role: z.enum(['user', 'assistant']),
      model: z.string().or(z.undefined()),
      startedAt: z.number(),
    })
    .or(z.undefined()),
  pendingPermission: PermissionRequest.or(z.undefined()),
  grants: z.array(PermissionGrantSchema),
  untrustedContext: UntrustedContextSchema.or(z.undefined()),
  todos: z.array(Todo),
  runningCalls: z.array(z.tuple([CallId, RunningCallSchema])),
  interruptedCalls: z.array(RunningCallSchema),
  runningSubagents: z.array(z.tuple([AgentId, RunningSubagentSchema])),
  ptySessions: z.array(z.tuple([PtySessionId, OpenPtySessionSchema])),
  config: ConfigPatch,
  usage: UsageTotalsSchema,
  compactions: z.array(CompactionSchema),
  checkpoints: z.array(CheckpointSchema),
  notices: z.array(NoticeSchema),
  lastError: XmError.or(z.undefined()),
  lastSeq: z.number().int().nonnegative(),
});
export const ReadSessionResult = SerializedSessionStateResult;
