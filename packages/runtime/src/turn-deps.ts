import type { CallId, PriceTable, ToolCallOrigin } from '@xm/contracts';
import type {
  AbortLike,
  BlobStore,
  CodeRuntime,
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
   * Code Mode 的隔离运行时（ADR-0069）。**缺席即没装**，`ctx.codeMode` 跟着缺席，
   * `run_code` 拿不到跑程序的地方。Code Mode 是 opt-in，这是它在装配上的表达。
   *
   * runtime 只认识 `@xm/kernel` 的这个端口，不认识 `@xm/code-runtime`——
   * depcruise 的「内核与运行时不得依赖-code-runtime」盯着这条。
   */
  readonly codeRuntime?: CodeRuntime;
  /**
   * 工具在提示词里的呈现模式（ADR-0061 §二）。缺席即 `native`——Code Mode 是 opt-in。
   *
   * 它只影响**模型视野**：`code` 模式下模型只看得见 `run_code`，直接点名别的工具会
   * 在判定之前就得到"没有这个工具"。程序发起的子调用不受它约束，
   * 否则 `code` 模式下 Code Mode 自己也没工具可调了。
   */
  readonly toolPresentation?: 'native' | 'code' | 'both';
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
