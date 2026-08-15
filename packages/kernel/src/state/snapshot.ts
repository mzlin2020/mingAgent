import type {
  AgentId,
  CallId,
  ConfigPatch,
  Message,
  PtySessionId,
  SessionId,
  Todo,
  TurnId,
  XmError,
} from '@xm/contracts';
import type {
  ActiveMessage,
  Checkpoint,
  Compaction,
  EditProposalState,
  Notice,
  OpenPtySession,
  RunningCall,
  RunningSubagent,
  SessionState,
  SessionStatus,
  UntrustedContext,
  UsageTotals,
} from './session-state.js';

/**
 * `SessionState` 的可序列化镜像（ADR-0032 修 G4/G5）。
 *
 * `SessionState` 里的三个 `ReadonlyMap` 不能直接 `JSON.stringify` 或过
 * `structuredClone` 之外的传输通道（比如落 SQLite 的 `TEXT` 列），所以快照
 * 落盘/过 IPC 前先换成 entry 数组，读回来再换回去——这是**唯一**的差别，
 * 其余字段原样照抄，一个字段都不许在这里重新诠释语义。
 *
 * **这是纯派生数据。** 它能表达的每一位信息都已经在事件流里，`serialize`/
 * `deserialize` 是一对纯函数（不读时间、不 I/O），坏了/丢了都可以从事件流
 * 重新 `reduceAll` 出来——这条性质必须一直成立，否则快照就从"加速手段"
 * 变成了"事件流之外的第二个事实来源"，那正是 ADR-0015/0021 反复强调要
 * 防的东西。
 */
export interface SerializedSessionState {
  readonly id: SessionId;
  readonly title: string;
  readonly cwd: string;
  readonly modelRef: string;
  readonly status: SessionStatus;
  readonly messages: readonly Message[];
  readonly activeTurn: { readonly turnId: TurnId; readonly startedAt: number } | undefined;
  readonly activeMessage: ActiveMessage | undefined;
  readonly untrustedContext: UntrustedContext | undefined;
  readonly todos: readonly Todo[];
  readonly editProposals: readonly EditProposalState[];
  readonly presentations: readonly (readonly [CallId, unknown])[];
  readonly runningCalls: readonly (readonly [CallId, RunningCall])[];
  readonly interruptedCalls: readonly RunningCall[];
  readonly runningSubagents: readonly (readonly [AgentId, RunningSubagent])[];
  readonly ptySessions: readonly (readonly [PtySessionId, OpenPtySession])[];
  readonly config: ConfigPatch;
  readonly usage: UsageTotals;
  readonly compactions: readonly Compaction[];
  readonly checkpoints: readonly Checkpoint[];
  readonly notices: readonly Notice[];
  readonly lastError: XmError | undefined;
  readonly lastSeq: number;
}

/** `SessionState` → 可过 JSON/IPC 的镜像。纯函数，不改入参。 */
export function serializeSessionState(state: SessionState): SerializedSessionState {
  return {
    id: state.id,
    title: state.title,
    cwd: state.cwd,
    modelRef: state.modelRef,
    status: state.status,
    messages: state.messages,
    activeTurn: state.activeTurn,
    activeMessage: state.activeMessage,
    untrustedContext: state.untrustedContext,
    todos: state.todos,
    editProposals: state.editProposals,
    presentations: [...state.presentations.entries()],
    runningCalls: [...state.runningCalls.entries()],
    interruptedCalls: state.interruptedCalls,
    runningSubagents: [...state.runningSubagents.entries()],
    ptySessions: [...state.ptySessions.entries()],
    config: state.config,
    usage: state.usage,
    compactions: state.compactions,
    checkpoints: state.checkpoints,
    notices: state.notices,
    lastError: state.lastError,
    lastSeq: state.lastSeq,
  };
}

/** 镜像 → `SessionState`。是 `serializeSessionState` 的精确逆函数（往返测试见测试文件）。 */
export function deserializeSessionState(s: SerializedSessionState): SessionState {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    modelRef: s.modelRef,
    status: s.status,
    messages: s.messages,
    activeTurn: s.activeTurn,
    activeMessage: s.activeMessage,
    untrustedContext: s.untrustedContext,
    todos: s.todos,
    editProposals: s.editProposals,
    presentations: new Map(s.presentations),
    runningCalls: new Map(s.runningCalls),
    interruptedCalls: s.interruptedCalls,
    runningSubagents: new Map(s.runningSubagents),
    ptySessions: new Map(s.ptySessions),
    config: s.config,
    usage: s.usage,
    compactions: s.compactions,
    checkpoints: s.checkpoints,
    notices: s.notices,
    lastError: s.lastError,
    lastSeq: s.lastSeq,
  };
}
