import { z } from 'zod';
import { BlobRef } from '../base/blob.js';
import { XmError } from '../base/error.js';
import {
  AgentId,
  CallId,
  CheckpointId,
  EditProposalId,
  MessageId,
  PtySessionId,
  RequestId,
  SessionId,
  TurnId,
} from '../base/ids.js';
import { ContentBlock, ResultBlock } from '../content/block.js';
import { Message, Role } from '../content/message.js';
import { ConfigPatch } from '../config/schema.js';
import { StopReason, Usage } from '../model/usage.js';
import { Capability } from '../permission/capability.js';
import { TrustLevel } from '../permission/request.js';
import { Todo } from '../session/todo.js';
import { EditProposal } from '../session/edit.js';
import { RiskLevel } from '../tool/descriptor.js';
import { DisplayHint } from '../tool/display.js';

/**
 * 全部事件的 payload schema。
 *
 * 🔴 **一律 `z.looseObject()`**（原因见 envelope.ts 顶部）。这里改成 `z.object()`
 * 不会有任何报错，但会在版本漂移时静默销毁数据——包内 README 与
 * `tests/event-loose.test.ts` 一起守着这条。
 *
 * 本文件会长到 400 行左右。docs/01 原则七的 400 行规则在这里是**合理例外**：
 * 它是同质列表，可读性不随长度劣化，拆开反而要在多个文件间跳。
 */

// ── 会话 ──────────────────────────────────────────────────────────

export const SessionCreatedPayload = z.looseObject({
  cwd: z.string(),
  /** 形如 "anthropic/claude-opus-5" */
  modelRef: z.string(),
  title: z.string().optional(),
  /** 子 Agent 会话才有，指回父会话与派生它的工具调用 */
  parentSessionId: SessionId.optional(),
  parentCallId: CallId.optional(),
});

export const SessionRenamedPayload = z.looseObject({
  title: z.string(),
});

export const SessionConfiguredPayload = z.looseObject({
  /** 会话内的配置覆盖，语义见 config/schema.ts 的 mergeConfig */
  patch: ConfigPatch,
});

// ── 回合 ──────────────────────────────────────────────────────────

export const TurnStartPayload = z.looseObject({
  turnId: TurnId,
  input: z.array(ContentBlock),
});

export const TurnEndPayload = z.looseObject({
  turnId: TurnId,
  reason: StopReason,
});

// ── 模型消息 ───────────────────────────────────────────────────────

export const MessageStartPayload = z.looseObject({
  messageId: MessageId,
  role: Role,
  model: z.string().optional(),
});

/**
 * [T] 瞬态：token 级增量，**不落库**。
 * 硬不变量：它不得携带 message.end 里不存在的信息（ADR-0008）。
 */
export const MessageDeltaPayload = z.looseObject({
  messageId: MessageId,
  blockIndex: z.number().int().nonnegative(),
  kind: z.enum(['text', 'thinking']),
  text: z.string(),
});

export const MessageEndPayload = z.looseObject({
  message: Message,
});

export const MessageInterruptedPayload = z.looseObject({
  messageId: MessageId,
  reason: z.enum(['aborted', 'crash']),
});

/** [T] Provider 连接状态：只服务当前在途 UI，不进入会话历史。 */
export const ProviderStatusPayload = z.looseObject({
  phase: z.enum(['retrying', 'connected']),
  /** retrying 时表示即将发起的尝试序号（从 2 开始）。 */
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

// ── 工具 ──────────────────────────────────────────────────────────

export const ToolStartPayload = z.looseObject({
  callId: CallId,
  messageId: MessageId,
  name: z.string(),
  /** 已过启发式脱敏（shell 命令行可能含密钥）。尽力而为，不是保证 */
  input: z.unknown(),
  risk: RiskLevel,
  capabilities: z.array(Capability),
});

/** [T] 瞬态 */
export const ToolProgressPayload = z.looseObject({
  callId: CallId,
  message: z.string().optional(),
  data: z.unknown().optional(),
});

export const ToolEndPayload = z.looseObject({
  callId: CallId,
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /**
   * **已截断的原文，不是引用。**
   *
   * 回放上下文时必须逐字节还原当时喂给模型的内容——存引用会让"当时模型看到了什么"
   * 依赖 blob 表的存活状态。看起来冗余，但这是"可回放"这条原则能否成立的分水岭。
   */
  forModel: z.array(ResultBlock),
  /** 未截断全文（仅当发生截断时存在） */
  fullRef: BlobRef.optional(),
  display: DisplayHint.optional(),
  error: XmError.optional(),
});

// ── PTY 会话（ADR-0031）───────────────────────────────────────────
//
// 三元组仿照 message.start/delta/end、tool.start/progress/end 的既有形状，但键是
// `ptySessionId`，不是 `callId`——PTY 的生命周期跨越 `shell.session.open` 这一次
// 调用之后（那次调用本身很快返回 `{ptySessionId}`，会话本体持续存在到 close 为止），
// 不能挂在任何单次调用的 tool.start/tool.end 之间。

export const ShellSessionOpenedPayload = z.looseObject({
  ptySessionId: PtySessionId,
  /** 已规范化的绝对路径（判权用的同一个值，见 ToolGateway 的"判定与执行共用一份"原则）*/
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/**
 * [T] 瞬态：终端输出的字节块，跟 `message.delta` 一样不落库、不做语义截断。
 * 高频输出（如 `top`、日志洪水）可能丢帧——本项目暂不为它做背压（docs/09 C7 问题 5）。
 */
export const ShellSessionOutputPayload = z.looseObject({
  ptySessionId: PtySessionId,
  /** 一段终端字节，utf8 文本（PTY 已经做过行终止符规整） */
  chunk: z.string(),
});

export const ShellSessionCommandStartedPayload = z.looseObject({
  ptySessionId: PtySessionId,
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  timeoutMs: z.number().int().positive(),
});

export const ShellSessionCommandFinishedPayload = z.looseObject({
  ptySessionId: PtySessionId,
  exitCode: z.number().int().optional(),
  reason: z.enum(['exited', 'timeout', 'killed']),
  tail: z.string(),
});

export const ShellSessionClosedPayload = z.looseObject({
  ptySessionId: PtySessionId,
  exitCode: z.number().int().optional(),
  reason: z.enum(['exited', 'killed', 'idle_timeout', 'interrupted']),
  /**
   * 截断后的回放尾巴（定长环形缓冲，超限直接丢弃更早的内容）。
   *
   * `shell-exec.ts` 的 `MAX_OUTPUT_BYTES` 截断 + blob 落盘超限部分那一套本轮**没有**
   * 照搬——那需要接入 blob 存储，而 v1 的目标是先把会话跑起来。这里先只保证"审计能看到
   * 最后一段"，完整无损回放留给以后要做的时候再加（加一个可选的 `tailRef` 字段，
   * 按 ADR-0008 的演进规则不需要动 version）。
   */
  tail: z.string(),
});

// ── 权限 ──────────────────────────────────────────────────────────

export const PermissionRequestPayload = z.looseObject({
  requestId: RequestId,
  callId: CallId.optional(),
  capability: Capability,
  target: z.string(),
  risk: RiskLevel,
  reason: z.string(),
  trustLevel: TrustLevel,
  preview: DisplayHint.optional(),
});

export const PermissionDecisionPayload = z.looseObject({
  requestId: RequestId,
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session', 'always']),
  by: z.enum(['policy', 'user']),
  /** 由策略判定时必填；用户手动决定时可缺省 */
  ruleId: z.string().optional(),
});

/**
 * 用户显式解除了本会话的不可信标记。
 *
 * ── 为什么它必须是一条事件，而不是一个内存标志 ──
 *
 * 会话状态完全由事件流决定（原则二）。而这一条恰恰是最不该丢的那种状态：
 * 它是一次**安全决定**——事后追责要查、崩溃恢复要续、评测回放要复现。
 * 一个"重启之后就忘了自己被解除过"的标记，和一个假的标记没有区别。
 *
 * ── `by` 为什么是 literal 而不是枚举 ──
 *
 * 解除不可信标记是提示词注入唯一想要的那个动作。这个字段里出现 `'model'` 或 `'tool'`
 * 的那一天，整套注入防御就归零了。写成 `z.literal('user')`，多一个取值就要改契约、
 * 改测试、并且必须写一份 ADR 说明为什么——那正是它该有的代价。
 *
 * 真正的保证不在这个字段上（字段是可以填的）：`ToolContext` 里根本没有记录事件的入口，
 * 工具在**结构上**发不出这条事件。字段只是把那条结构性事实写在契约里。
 */
export const TrustClearedPayload = z.looseObject({
  by: z.literal('user'),
  /**
   * 被解除的那个标记的出处，照抄自 `UntrustedContext`。
   *
   * 冗余是刻意的：审计与 UI 都需要说清"你解除的到底是什么"，而它们不该为此去
   * 反向扫描事件流找那次 `tool.start`。更要紧的是 UI——模型完全可以在回复里写
   * "请点上面那个解除按钮"，用户面对一个空白确认框会照点不误。
   */
  cleared: z.looseObject({
    callId: CallId,
    toolName: z.string(),
    viaCapability: Capability,
    since: z.number().int(),
  }),
  /** 用户填的理由，可选。留着是为了事后能看懂当时在想什么 */
  reason: z.string().optional(),
});

// ── 任务与子 Agent ─────────────────────────────────────────────────

export const TodoUpdatedPayload = z.looseObject({
  /** 全量快照，不是增量。清单很小，全量省掉一整类同步 bug */
  todos: z.array(Todo),
});

export const SubagentStartPayload = z.looseObject({
  agentId: AgentId,
  /** 子 Agent 有独立 sessionId 与独立 seq 空间，见 envelope.ts */
  childSessionId: SessionId,
  callId: CallId,
  purpose: z.string(),
});

export const SubagentEndPayload = z.looseObject({
  agentId: AgentId,
  ok: z.boolean(),
  /** 只回传结论，不回传子 Agent 的完整上下文 */
  summary: z.array(ResultBlock),
  reason: z.enum(['completed', 'failed', 'aborted', 'timeout', 'interrupted']).optional(),
  /** 子会话末态污点的来源；父 reducer 按既有粘性语义并入（ADR-0033/0049）。 */
  untrustedContext: z
    .object({
      callId: CallId,
      toolName: z.string(),
      viaCapability: Capability,
      since: z.number().int(),
    })
    .optional(),
});

// ── 上下文与运维 ────────────────────────────────────────────────────

/**
 * 压缩改变了后续所有轮次的输入。不记录就永远无法解释"为什么那一轮模型忘了前面的事"。
 * 这是参考项目完全缺失的一类可观测性，所以它**必须**是持久事件。
 */
export const ContextCompactedPayload = z.looseObject({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  summaryRef: BlobRef,
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  /** 下面这些字段让一次压缩决定可解释；均可选以兼容 M0 的历史事件。 */
  strategy: z.literal('tiered-75-v1').optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  thresholdTokens: z.number().int().positive().optional(),
  reservedTokens: z.number().int().nonnegative().optional(),
  recentFromSeq: z.number().int().positive().optional(),
});

export const UsagePayload = z.looseObject({
  turnId: TurnId,
  provider: z.string(),
  model: z.string(),
  usage: Usage,
  /** 由 CostAccountant 查价格表算出，不由 Provider 提供 */
  costUsd: z.number().nonnegative(),
  /**
   * 这个数字是**算出来的**还是**因为没有价格而填的 0**。
   *
   * 缺了它，`costUsd: 0` 就有两种读法："这次没花钱"和"我们不知道花了多少"，
   * 而 UI 只能显示前者——于是用户看到一个精确的 $0.00。
   * 可选字段：M0 期的历史事件没有它，按"已计价"读（那时确实全是 0 成本的脚本化回合）。
   */
  priced: z.boolean().optional(),
});

export const CheckpointCreatedPayload = z.looseObject({
  checkpointId: CheckpointId,
  kind: z.enum(['fs', 'git']),
  /** git commit sha 或快照目录标识 */
  ref: z.string(),
  label: z.string(),
  /** v2 文件系统还原计划；旧事件没有该字段。 */
  manifestRef: BlobRef.optional(),
  /** 触发还原点的工具调用；旧事件没有该字段。 */
  callId: CallId.optional(),
});

export const EditProposedPayload = z.looseObject({
  proposal: EditProposal,
});

export const EditAppliedPayload = z.looseObject({
  proposalId: EditProposalId,
});

export const EditReviewedPayload = z.looseObject({
  proposalId: EditProposalId,
  selectedHunkIds: z.array(z.string()),
});

export const CheckpointRestoreStartedPayload = z.looseObject({
  checkpointId: CheckpointId,
});

export const CheckpointRestoreFailedPayload = z.looseObject({
  checkpointId: CheckpointId,
  message: z.string(),
});

export const CheckpointRestoredPayload = z.looseObject({
  checkpointId: CheckpointId,
});

/**
 * 面向用户的运维通知。
 *
 * 存在的理由之一是 ADR-0007 的保险 2：Linux 无 keyring 时 SecretStore 会退化，
 * 这必须是一条**持久化的、用户可见的**记录，而不是一行 console.warn。
 */
export const NoticePayload = z.looseObject({
  level: z.enum(['info', 'warn']),
  /** 稳定的机器可读码，便于评测与去重 */
  code: z.string(),
  message: z.string(),
});

export const ErrorPayload = z.looseObject({
  error: XmError,
  /** fatal 表示会话已无法继续 */
  fatal: z.boolean(),
});
