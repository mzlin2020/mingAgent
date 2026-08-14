import type { CallId, PriceTable } from '@xm/contracts';
import type {
  AbortLike,
  BlobStore,
  Checkpointer,
  ExecutionWorld,
  ModelProvider,
  OsFamily,
  RuleLayer,
  ToolAvailabilityContext,
  ToolGateway,
  ToolRegistry,
} from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

export interface TurnCoreDeps {
  readonly runtime: SessionRuntime;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly executor: ExecutionWorld;
  readonly toolAvailability?: Omit<ToolAvailabilityContext, 'cwd'>;
  readonly layers: readonly RuleLayer[];
  readonly model: string;
  readonly hostOs?: OsFamily;
  readonly signal?: AbortLike;
  readonly pathCaseInsensitive?: boolean;
  readonly gateway?: ToolGateway;
  readonly checkpointer?: Checkpointer;
  readonly blobs?: BlobStore;
  readonly prices?: PriceTable;
  readonly maxIterations?: number;
}

export interface PendingCall {
  readonly callId: CallId;
  readonly name: string;
  argsJson: string;
}
