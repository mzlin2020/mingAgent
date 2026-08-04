import type {
  AgentId,
  BlobRef,
  CallId,
  Capability,
  CheckpointId,
  ConfigPatch,
  Message,
  MessageId,
  PermissionRequest,
  RequestId,
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
  readonly pendingPermission: PermissionRequest | undefined;

  /**
   * 用户在本会话里给出的、**范围超过单次**的授权（scope = session / always）。
   *
   * 之前 `permission.decision` 事件只用来清空 `pendingPermission`，决定本身不落进状态——
   * 于是"回放事件流得到的状态"和"当时真实的状态"不一致：一个授权过 `shell.exec` 的会话，
   * 回放出来看不出授权过。这在事件溯源系统里是个硬伤：状态必须完全由事件决定，
   * 而**安全决定恰恰是最不该丢的那部分**（审计要查、崩溃恢复要续、评测回放要复现）。
   */
  readonly grants: readonly PermissionGrant[];

  readonly todos: readonly Todo[];
  readonly runningCalls: ReadonlyMap<CallId, RunningCall>;
  /** turn.end 时仍在 runningCalls 里的调用 —— 崩溃恢复时它们要被标记为中断 */
  readonly interruptedCalls: readonly RunningCall[];
  readonly runningSubagents: ReadonlyMap<AgentId, RunningSubagent>;

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

export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'error';

/**
 * 一条超出单次范围的权限决定。
 *
 * 刻意保留 `effect: 'deny'`：用户点"本会话都拒绝"和点"本会话都允许"一样是决定，
 * 只记允许不记拒绝，回放出来的状态就是偏松的那一侧。
 */
export interface PermissionGrant {
  readonly requestId: RequestId;
  readonly capability: Capability;
  /** 授权针对的目标（路径 / host / 命令行），取自对应的 permission.request */
  readonly target: string;
  readonly effect: 'allow' | 'deny';
  readonly scope: 'session' | 'always';
  readonly ts: number;
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
}

export interface RunningSubagent {
  readonly agentId: AgentId;
  readonly childSessionId: SessionId;
  readonly purpose: string;
  readonly startedAt: number;
}

export interface UsageTotals {
  readonly usage: Usage;
  readonly costUsd: number;
  readonly turns: number;
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
  pendingPermission: undefined,
  grants: [],
  todos: [],
  runningCalls: new Map(),
  interruptedCalls: [],
  runningSubagents: new Map(),
  config: {},
  usage: { usage: EMPTY_USAGE, costUsd: 0, turns: 0 },
  compactions: [],
  checkpoints: [],
  notices: [],
  lastError: undefined,
  lastSeq: 0,
});
