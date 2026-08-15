import type { ContainerContext, ContainerPlugin } from '@xm/kernel';
import { PluginContainer } from '@xm/kernel';
import { ContextBuilder } from './context-builder.js';
import { TurnExtensionHost } from './turn-extension-host.js';
import type {
  ToolExecutionResult,
  TurnPreStepResult,
  TurnStoppingDecision,
} from './turn-events.js';
import { recordTurnCheckpoint } from './turn-checkpoint.js';
import { capToolResult } from './turn-result.js';

export interface TurnPluginServices {
  readonly turnExtensions: TurnExtensionHost;
}

type TurnServiceKey = Extract<keyof TurnPluginServices, string>;

export const createTurnExtensionHost = <S extends object>(ctx: ContainerContext<S>): TurnExtensionHost =>
  new TurnExtensionHost(ctx);

export const installContextBuilder = (host: TurnExtensionHost): (() => unknown) =>
  host.onPreStep(async (_signal, input, next): Promise<TurnPreStepResult> => {
    const downstream = await next();
    if (input.kind !== 'request') return downstream;
    // ADR-0055：包装 next() 的监听器有责任保留下游的修改。下游已经产出请求就用它的，
    // ContextBuilder 只负责“没人产出时兜底产出一份”——否则 patch 插到本行之后的插件会被静默吞掉。
    if (downstream.kind === 'request') return downstream;
    return { kind: 'request', request: await new ContextBuilder(input.deps).build(input.turnId) };
  });

export const installMultimodalGuard = (host: TurnExtensionHost): (() => unknown) =>
  host.onPreStep(async (_signal, input, next): Promise<TurnPreStepResult> => {
    if (input.kind === 'admission') {
      const caps = input.deps.provider.capabilities(input.deps.model);
      if (input.input.some((block) => block.type === 'image') && !caps.vision) {
        throw new Error(
          `模型 ${input.deps.model} 不支持图片输入（vision），请换一个支持的模型或去掉图片后再试。`,
        );
      }
      if (input.input.some((block) => block.type === 'document') && !caps.documents) {
        throw new Error(
          `模型 ${input.deps.model} 不支持文档输入，请换一个支持的模型或去掉附件后再试。`,
        );
      }
    }
    return next();
  });

export const installCheckpoint = (host: TurnExtensionHost): (() => unknown) =>
  host.onToolExecute(async (_signal, input, next): Promise<ToolExecutionResult> => {
    await recordTurnCheckpoint(
      input.deps,
      input.turnId,
      input.call.callId,
      input.tool,
      input.input,
      input.ctx,
      input.claims,
    );
    return next();
  });

export const installResultTruncation = (host: TurnExtensionHost): (() => unknown) =>
  host.onToolPostExecute(async (_signal, input, next): Promise<ToolExecutionResult> => {
    const result = await next();
    const capped = await capToolResult(input.deps, [...result.forModel], input.tool);
    return {
      ...result,
      forModel: capped.forModel,
      ...(capped.fullRef === undefined ? {} : { fullRef: capped.fullRef }),
    };
  });

export const installStoppingGuard = (host: TurnExtensionHost): (() => unknown) =>
  host.onStopping((_signal, input): TurnStoppingDecision => {
    const maxIterations = input.deps.maxIterations ?? 9999;
    if (input.phase === 'after-stream') {
      if (input.callCount === 0 && input.stopReason === 'max_tokens') {
        if (input.maxTokenContinuations === 0) {
          return {
            action: 'continue',
            reason: input.stopReason,
            maxTokenContinuations: 1,
          };
        }
        return {
          action: 'stop',
          reason: input.stopReason,
          maxTokenContinuations: input.maxTokenContinuations,
          notice: {
            code: 'turn.max_tokens',
            message: '模型连续两次达到输出上限，任务可能尚未完成。请让小明继续，或缩小任务范围。',
          },
        };
      }
      if (
        input.callCount === 0 ||
        input.stopReason === 'aborted' ||
        input.stopReason === 'error'
      ) {
        return {
          action: 'stop',
          reason: input.stopReason,
          maxTokenContinuations: input.maxTokenContinuations,
        };
      }
      return {
        action: 'dispatch-tools',
        reason: input.stopReason,
        maxTokenContinuations: input.maxTokenContinuations,
      };
    }
    if (input.iteration >= maxIterations) {
      return {
        action: 'stop',
        reason: 'max_iterations',
        maxTokenContinuations: input.maxTokenContinuations,
        notice: {
          code: 'turn.max_iterations',
          message: `本回合达到 ${String(maxIterations)} 次模型往返上限，已停止。`,
        },
      };
    }
    return {
      action: 'continue',
      reason: input.stopReason,
      maxTokenContinuations: input.maxTokenContinuations,
    };
  });

const plugin = (
  name: string,
  inject: readonly TurnServiceKey[],
  provide: readonly TurnServiceKey[],
  apply: ContainerPlugin<TurnPluginServices>['apply'],
): ContainerPlugin<TurnPluginServices> => ({ name, inject, provide, apply });

export interface DefaultTurnExtensions {
  readonly host: TurnExtensionHost;
  dispose(): Promise<void>;
}

/** 未走 profile 的包内测试与嵌入入口，也装同一组插件，不保留第二套流程。 */
export async function createDefaultTurnExtensions(): Promise<DefaultTurnExtensions> {
  const container = new PluginContainer<TurnPluginServices>();
  container.use(
    plugin('turn.driver', [], ['turnExtensions'], (ctx) =>
      ctx.provide('turnExtensions', createTurnExtensionHost(ctx)),
    ),
  );
  container.use(
    plugin('turn.multimodal', ['turnExtensions'], [], (ctx) =>
      installMultimodalGuard(ctx.turnExtensions),
    ),
  );
  container.use(
    plugin('turn.context', ['turnExtensions'], [], (ctx) =>
      installContextBuilder(ctx.turnExtensions),
    ),
  );
  container.use(
    plugin('turn.checkpoint', ['turnExtensions'], [], (ctx) =>
      installCheckpoint(ctx.turnExtensions),
    ),
  );
  container.use(
    plugin('turn.truncation', ['turnExtensions'], [], (ctx) =>
      installResultTruncation(ctx.turnExtensions),
    ),
  );
  container.use(
    plugin('turn.stopping', ['turnExtensions'], [], (ctx) =>
      installStoppingGuard(ctx.turnExtensions),
    ),
  );
  try {
    await container.start();
  } catch (error) {
    await container.dispose();
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return { host: container.context.turnExtensions, dispose: () => container.dispose() };
}
