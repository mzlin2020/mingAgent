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
