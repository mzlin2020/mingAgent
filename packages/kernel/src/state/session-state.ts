import type {
  AgentId,
  BlobRef,
  CallId,
  CheckpointId,
  ConfigPatch,
  Message,
  PermissionRequest,
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

export interface ActiveMessage {
  readonly messageId: string;
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
