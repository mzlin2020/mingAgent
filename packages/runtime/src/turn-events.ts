import type {
  BlobRef,
  ContentBlock,
  ModelChunk,
  ModelRequest,
  PolicyVerdict,
  ResultBlock,
  StopReason,
  TurnId,
  XmError,
} from '@xm/contracts';
import type {
  AbortLike,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';
import {
  defineParallelEvent,
  defineSerialEvent,
  defineWaterfallEvent,
} from '@xm/kernel';
import type { PendingCall, TurnCoreDeps } from './turn-deps.js';

export type TurnPreStepInput =
  | { readonly kind: 'admission'; readonly deps: TurnCoreDeps; readonly input: readonly ContentBlock[] }
  | { readonly kind: 'request'; readonly deps: TurnCoreDeps; readonly turnId: TurnId };

export type TurnPreStepResult =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'request'; readonly request: ModelRequest };

export interface TurnRequestEventInput {
  readonly deps: TurnCoreDeps;
  readonly turnId: TurnId;
  readonly request: ModelRequest;
}

export type LlmStreamInput = TurnRequestEventInput;

export interface TurnStepErrorInput {
  readonly deps: TurnCoreDeps;
  readonly turnId: TurnId;
  readonly error: unknown;
  readonly attempt: number;
}

export type TurnStepErrorDecision = 'stop' | 'retry';

export interface TurnStoppingInput {
  readonly deps: TurnCoreDeps;
  readonly turnId: TurnId;
  readonly phase: 'after-stream' | 'after-tools';
  readonly iteration: number;
  readonly stopReason: StopReason;
  readonly callCount: number;
  readonly maxTokenContinuations: number;
}

export interface TurnStoppingDecision {
  readonly action: 'continue' | 'stop' | 'dispatch-tools';
  readonly reason: StopReason;
  readonly maxTokenContinuations: number;
  readonly notice?: { readonly code: string; readonly message: string };
}

export interface ToolPreExecuteInput {
  readonly deps: TurnCoreDeps;
  readonly turnId: TurnId;
  readonly call: Readonly<PendingCall>;
  readonly tool: RegisteredTool;
  readonly input: unknown;
  readonly ctx: Readonly<ToolContext>;
  readonly claims: readonly PermissionClaim[];
}

/**
 * 十二步链前五步（特权链段）的产物：工具找到了、入参定形了、网关规范化并回写了、
 * 主张完备。**判定还没做**——它是第 ⑥⑦ 步的输入。
 *
 * 拿出来单独命名，是因为 M3-h 之后它有两个消费者：模型发起的调用，和 Code Mode 里
 * 程序发起的子调用。两条路共用同一份准备与判定，**只有记录方式不同**（见 `CallSink`）。
 */
export interface PreparedCall {
  readonly tool: RegisteredTool;
  readonly input: unknown;
  readonly ctx: ToolContext;
  readonly claims: readonly PermissionClaim[];
}

export interface ToolGuardResult {
  readonly verdict: PolicyVerdict;
  readonly deniedClaim?: PermissionClaim;
}

export interface ExecutionReceipt {
  readonly callId: string;
  readonly issuedAt: number;
  readonly toolName: string;
}

export type ToolExecuteInput = ToolPreExecuteInput;

export interface ToolExecutionResult {
  readonly forModel: readonly ResultBlock[];
  readonly error?: XmError;
  readonly receipt?: ExecutionReceipt;
  readonly fullRef?: BlobRef;
  /**
   * 工具随结果 yield 出来的展示事实（ADR-0058）。**尚未校验**——
   * 落库前由 `RegisteredTool.parsePresentation` 过一遍工具自己的 schema，
   * 没声明 schema 或校验不过就不落。
   */
  readonly presentation?: unknown;
  /**
   * 工具随结果 yield 出来的**规范输出值**（ADR-0071）。**已过工具自己的 `outputSchema`**
   * ——与 `presentation` 相反，它在 `executeToolBody` 捕获的那一刻就校验完了。
   *
   * 差别的理由：展示事实还要走到 `record('tool.end')` 那一步，schema 是它进事件流前的
   * 最后一道关；规范值永远不进事件流，工具 yield 的那一刻就是唯一的关口。
   *
   * **它不落库**，只在这一次调用的生命周期内存在，供 `tool/post-execute`、
   * `tool/result` 与（M3-h 起）Code Mode 的子调用返回值使用。
   */
  readonly output?: unknown;
}

export interface ToolPostExecuteInput extends ToolExecuteInput {
  readonly result: ToolExecutionResult;
}

export interface ToolResultObservation extends ToolPostExecuteInput {
  readonly durationMs: number;
}

export const TURN_PRE_STEP = defineWaterfallEvent<[TurnPreStepInput], TurnPreStepResult>(
  'turn/pre-step',
);
export const TURN_REQUEST = defineWaterfallEvent<[TurnRequestEventInput], ModelRequest>('turn/request');
export const LLM_STREAM = defineWaterfallEvent<[LlmStreamInput], AsyncIterable<ModelChunk>>(
  'llm/stream',
);
export const TURN_STEP_ERROR = defineWaterfallEvent<
  [TurnStepErrorInput],
  TurnStepErrorDecision
>('turn/step-error');
export const TURN_STOPPING = defineSerialEvent<[TurnStoppingInput], TurnStoppingDecision>(
  'turn/stopping',
);
export const TOOL_PRE_EXECUTE = defineWaterfallEvent<[ToolPreExecuteInput], ToolGuardResult>(
  'tool/pre-execute',
);
export const TOOL_EXECUTE = defineWaterfallEvent<[ToolExecuteInput], ToolExecutionResult>(
  'tool/execute',
);
export const TOOL_POST_EXECUTE = defineWaterfallEvent<
  [ToolPostExecuteInput],
  ToolExecutionResult
>('tool/post-execute');
export const TOOL_RESULT = defineParallelEvent<[ToolResultObservation]>('tool/result');

export const NEVER_TURN_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
