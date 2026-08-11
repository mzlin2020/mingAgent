import type {
  AgentId,
  BlobRef,
  CallId,
  Capability,
  CheckpointId,
  ConfigPatch,
  Message,
  MessageId,
  PtySessionId,
  SessionId,
  Todo,
  TurnId,
  Usage,
  XmError,
} from '@xm/contracts';
import { EMPTY_USAGE } from '@xm/contracts';

/**
 * 会话状态 —— **完全由事件流 reduce 得出**，不允许有第二个来源。
 *
 * 注意：可选字段一律写成 `X | undefined` 而不是 `x?: X`。
 * 在 `exactOptionalPropertyTypes` 下，`x?: X` 无法用 `{ ...state, x: undefined }` 清空，
 * 每处清空都要写条件展开——对一个到处都在"设置/清空"的状态对象来说，
 * 那种写法的噪音远大于收益。
 */
export interface SessionState {
  readonly id: SessionId;
  readonly title: string;
  readonly cwd: string;
  readonly modelRef: string;
  readonly status: SessionStatus;

  /** 上下文装配的输入。**不含**压缩替换——压缩的摘要在 blob 里，reduce 读不到 I/O */
  readonly messages: readonly Message[];

  readonly activeTurn: { readonly turnId: TurnId; readonly startedAt: number } | undefined;
  readonly activeMessage: ActiveMessage | undefined;

  /**
   * 本会话的上下文是否已被外部内容污染，以及是被什么污染的。
   *
   * **由事件流算出，不由调用方填**（reduce.ts 的 `tool.start` 分支）。
   * 这是 `PermissionRequest.trustLevel` 的唯一来源——在此之前它被硬编码成 `'model'`，
   * 导致注入降级与三条 `red.*-untrusted` 红线全是死代码。
   *
   * **粘性的：一旦置上就不会自动清除。** 不可信内容进了 `messages` 就一直在里面，
   * 回合结束并不会把它从模型上下文里拿走——按回合清空等于"上一轮读的网页，
   * 这一轮就不算数了"，而跨回合正是注入最自然的形状（读网页 / 下一轮再让你 push）。
   * 清除只能由用户显式操作（M1 的解除入口，见 docs/09）。
   */
  readonly untrustedContext: UntrustedContext | undefined;

  readonly todos: readonly Todo[];
  readonly runningCalls: ReadonlyMap<CallId, RunningCall>;
  /** turn.end 时仍在 runningCalls 里的调用 —— 崩溃恢复时它们要被标记为中断 */
  readonly interruptedCalls: readonly RunningCall[];
  readonly runningSubagents: ReadonlyMap<AgentId, RunningSubagent>;
  readonly ptySessions: ReadonlyMap<PtySessionId, OpenPtySession>;

  /** 会话级配置覆盖的累积结果 */
  readonly config: ConfigPatch;

  readonly usage: UsageTotals;
  readonly compactions: readonly Compaction[];
  readonly checkpoints: readonly Checkpoint[];
  readonly notices: readonly Notice[];
  readonly lastError: XmError | undefined;

  /** **持久化流**的最大 seq。瞬态事件不推进它（见 reduce.ts） */
  readonly lastSeq: number;
}

/**
 * 会话状态机。
 *
 * 这里曾经有第四个取值 `'waiting_permission'`（会话挂在一个待批的权限请求上）。
 * ADR-0039 之后判定不会挂起——`evaluate()` 要么放行要么拒绝，拒绝立刻变成一条
 * 工具错误——于是没有任何事件能把会话推到那个状态。
 */
export type SessionStatus = 'idle' | 'running' | 'error';

/*
 * ── 这里曾经有 `pendingPermission` 与 `grants` / `PermissionGrant` ──
 *
 * 前者是"当前挂着的那个确认框"（由 `permission.request` 事件写入、`permission.decision`
 * 清空），后者是用户点过的"本会话都允许"/"永久允许"，由 `grantsToRules()` 读回去当
 * `session` 规则层。ADR-0039 删掉审批之后两者都没有了写入源。
 *
 * 两个 `permission.*` 事件本身**保留**：deny 仍然成对记录（`by: 'policy'`），
 * 它是"为什么这次被拦"的审计依据，也是老会话仍然能回放的前提（ADR-0008）。
 * 区别只是 `reduce()` 不再从它们派生状态——**审计记录与会话状态是两件事**，
 * 以前混在一起是因为要驱动那张卡片。
 */

/** 上下文被外部内容污染的出处。留够信息让 UI 能说清"因为哪一次调用" */
export interface UntrustedContext {
  /** 引入不可信内容的那次工具调用 */
  readonly callId: CallId;
  readonly toolName: string;
  /** 触发标记的能力（UNTRUSTED_CONTENT_CAPABILITIES 之一） */
  readonly viaCapability: Capability;
  readonly since: number;
}

export interface ActiveMessage {
  readonly messageId: MessageId;
  readonly role: 'user' | 'assistant';
  readonly model: string | undefined;
  readonly startedAt: number;
}

export interface RunningCall {
  readonly callId: CallId;
  readonly name: string;
  readonly startedAt: number;
  /** 触发这次调用的那条模型消息——崩溃恢复合成中断结果时用得上（orphan.ts） */
  readonly messageId: MessageId;
  /** 原始入参，同上 */
  readonly input: unknown;
}

export interface RunningSubagent {
  readonly agentId: AgentId;
  readonly childSessionId: SessionId;
  readonly purpose: string;
  readonly startedAt: number;
}

/**
 * 一个仍处于打开状态的 PTY 会话（`shell.session`，ADR-0031）。
 *
 * 只记回放/审计需要的信息——**不是**活的进程句柄，那个只存在于运行时的
 * `PtySessionManager` 里（内核零 I/O）。它存在的理由和 `runningCalls` 一样：
 * 回放事件流得到的状态必须能看出"这个会话当时是开着的"，而不是要等到看完
 * `shell.session.closed` 才知道。
 */
export interface OpenPtySession {
  readonly ptySessionId: PtySessionId;
  readonly cwd: string;
  readonly startedAt: number;
}

export interface UsageTotals {
  readonly usage: Usage;
  readonly costUsd: number;
  readonly turns: number;
  /**
   * 有多少次往返**没有价格可查**。
   *
   * 没有它，`costUsd` 就是一个不可解释的数：0.42 美元里可能还漏着三次不知价的调用，
   * 而 UI 会把它当成全部花销显示出来。有了它，UI 能诚实地说"至少 $0.42（3 次未计价）"。
   */
  readonly unpricedTurns: number;
}

export interface Compaction {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly summaryRef: BlobRef;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface Checkpoint {
  readonly checkpointId: CheckpointId;
  readonly kind: 'fs' | 'git';
  readonly ref: string;
  readonly label: string;
  readonly restoredAt: number | undefined;
}

export interface Notice {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly message: string;
  readonly ts: number;
}

/**
 * 空状态。`reduce` 的起点，必须是纯数据——不读时间、不生成 ID。
 * 真正的 id/cwd 由第一条 `session.created` 事件填上。
 */
export const emptySessionState = (id: SessionId): SessionState => ({
  id,
  title: '',
  cwd: '',
  modelRef: '',
  status: 'idle',
  messages: [],
  activeTurn: undefined,
  activeMessage: undefined,
  untrustedContext: undefined,
  todos: [],
  runningCalls: new Map(),
  interruptedCalls: [],
  runningSubagents: new Map(),
  ptySessions: new Map(),
  config: {},
  usage: { usage: EMPTY_USAGE, costUsd: 0, turns: 0, unpricedTurns: 0 },
  compactions: [],
  checkpoints: [],
  notices: [],
  lastError: undefined,
  lastSeq: 0,
});
