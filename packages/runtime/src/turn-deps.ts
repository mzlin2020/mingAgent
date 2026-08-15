import type { CallId, PriceTable, ToolCallOrigin } from '@xm/contracts';
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
  /**
   * 这一轮里某几次调用不是模型发起的（ADR-0065 §四）。键是 `callId`，缺席即
   * `{ kind: 'model' }`。
   *
   * 目前唯一的生产者是卡片动作：它把用户的一次点击变成一次**新的**工具调用，
   * 那次调用照常走完整十二步链，只是事件流里记得住"这是人点出来的"。
   */
  readonly callOrigins?: ReadonlyMap<CallId, ToolCallOrigin>;
}

export interface PendingCall {
  readonly callId: CallId;
  readonly name: string;
  argsJson: string;
}
