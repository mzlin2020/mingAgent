import type { ModelRequest } from '@xm/contracts';
import type {
  AbortLike,
  ContainerContext,
  ParallelListener,
  SerialListener,
  WaterfallListener,
} from '@xm/kernel';
import type {
  LlmStreamInput,
  ToolExecuteInput,
  ToolExecutionResult,
  ToolGuardResult,
  ToolPostExecuteInput,
  ToolPreExecuteInput,
  ToolResultObservation,
  TurnPreStepInput,
  TurnPreStepResult,
  TurnRequestEventInput,
  TurnStepErrorDecision,
  TurnStepErrorInput,
  TurnStoppingDecision,
  TurnStoppingInput,
} from './turn-events.js';
import {
  LLM_STREAM,
  NEVER_TURN_ABORTS,
  TOOL_EXECUTE,
  TOOL_POST_EXECUTE,
  TOOL_PRE_EXECUTE,
  TOOL_RESULT,
  TURN_PRE_STEP,
  TURN_REQUEST,
  TURN_STEP_ERROR,
  TURN_STOPPING,
} from './turn-events.js';

type EventContext = Pick<
  ContainerContext<Record<string, unknown>>,
  'on' | 'parallel' | 'serial' | 'waterfall'
>;

export class TurnExtensionHost {
  readonly #ctx: EventContext;

  constructor(ctx: EventContext) {
    this.#ctx = ctx;
  }

  onPreStep(listener: WaterfallListener<[TurnPreStepInput], TurnPreStepResult>): () => unknown {
    return this.#ctx.on(TURN_PRE_STEP, listener);
  }

  onRequest(listener: WaterfallListener<[TurnRequestEventInput], ModelRequest>): () => unknown {
    return this.#ctx.on(TURN_REQUEST, listener);
  }

  onStream(
    listener: WaterfallListener<
      [LlmStreamInput],
      AsyncIterable<import('@xm/contracts').ModelChunk>
    >,
  ): () => unknown {
    return this.#ctx.on(LLM_STREAM, listener);
  }

  onStepError(
    listener: WaterfallListener<[TurnStepErrorInput], TurnStepErrorDecision>,
  ): () => unknown {
    return this.#ctx.on(TURN_STEP_ERROR, listener);
  }

  onStopping(
    listener: SerialListener<[TurnStoppingInput], TurnStoppingDecision>,
  ): () => unknown {
    return this.#ctx.on(TURN_STOPPING, listener);
  }

  onToolPreExecute(
    listener: WaterfallListener<[ToolPreExecuteInput], ToolGuardResult>,
  ): () => unknown {
    return this.#ctx.on(TOOL_PRE_EXECUTE, listener);
  }

  onToolExecute(
    listener: WaterfallListener<[ToolExecuteInput], ToolExecutionResult>,
  ): () => unknown {
    return this.#ctx.on(TOOL_EXECUTE, listener);
  }

  onToolPostExecute(
    listener: WaterfallListener<[ToolPostExecuteInput], ToolExecutionResult>,
  ): () => unknown {
    return this.#ctx.on(TOOL_POST_EXECUTE, listener);
  }

  onToolResult(listener: ParallelListener<[ToolResultObservation]>): () => unknown {
    return this.#ctx.on(TOOL_RESULT, listener);
  }

  preStep(input: TurnPreStepInput): Promise<TurnPreStepResult> {
    const signal = input.kind === 'admission' ? NEVER_TURN_ABORTS : signalOf(input);
    return this.#ctx.waterfall(TURN_PRE_STEP, signal, input, () =>
      Promise.resolve({ kind: 'admitted' }),
    );
  }

  request(input: TurnRequestEventInput): Promise<ModelRequest> {
    return this.#ctx.waterfall(TURN_REQUEST, signalOf(input), input, () =>
      Promise.resolve(input.request),
    );
  }

  stream(input: LlmStreamInput): Promise<AsyncIterable<import('@xm/contracts').ModelChunk>> {
    return this.#ctx.waterfall(LLM_STREAM, signalOf(input), input, () =>
      Promise.resolve(input.deps.provider.stream(input.request, signalOf(input))),
    );
  }

  stepError(input: TurnStepErrorInput): Promise<TurnStepErrorDecision> {
    return this.#ctx.waterfall(TURN_STEP_ERROR, signalOf(input), input, () =>
      Promise.resolve('stop'),
    );
  }

  stopping(input: TurnStoppingInput): Promise<TurnStoppingDecision | undefined> {
    return this.#ctx.serial(TURN_STOPPING, signalOf(input), input);
  }

  preExecute(
    input: ToolPreExecuteInput,
    core: () => Promise<ToolGuardResult>,
  ): Promise<ToolGuardResult> {
    return this.#ctx.waterfall(TOOL_PRE_EXECUTE, signalOf(input), input, core);
  }

  execute(
    input: ToolExecuteInput,
    core: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    return this.#ctx.waterfall(TOOL_EXECUTE, signalOf(input), input, core);
  }

  postExecute(input: ToolPostExecuteInput): Promise<ToolExecutionResult> {
    return this.#ctx.waterfall(TOOL_POST_EXECUTE, signalOf(input), input, () =>
      Promise.resolve(input.result),
    );
  }

  async result(input: ToolResultObservation): Promise<void> {
    try {
      await this.#ctx.parallel(TOOL_RESULT, signalOf(input), input);
    } catch {
      // 只读观察者失败不得反向中断已经完成并落库的工具调用。
    }
  }
}

const signalOf = (input: { readonly deps: { readonly signal?: AbortLike } }): AbortLike =>
  input.deps.signal ?? NEVER_TURN_ABORTS;
