import type { ContentBlock, StopReason, TurnId } from '@xm/contracts';
import type { TurnExtensionHost } from './turn-extension-host.js';
import { createDefaultTurnExtensions } from './turn-plugins.js';
import { streamOnce } from './turn-stream.js';
import { createCodeModeSeam } from './turn-code.js';
import { planCallBatches } from './turn-schedule.js';
import { dispatchCall } from './turn-tools.js';
import type { TurnDeps } from './turn-types.js';

export type { PendingCall, TurnDeps } from './turn-types.js';

/** 最常见的输入形状；多模态入口直接传 ContentBlock[]。 */
export const textInput = (text: string): ContentBlock[] => [{ type: 'text', text }];

export async function runTurn(deps: TurnDeps, input: readonly ContentBlock[]): Promise<StopReason> {
  return withExtensions(deps, async (extensions) => {
    // admission 在 turn.start 前完成，拒绝多模态时不会留下孤儿回合。
    await extensions.preStep({ kind: 'admission', deps, input });
    const turnId = deps.runtime.ids.turn();
    await deps.runtime.record({
      type: 'turn.start',
      turnId,
      payload: { turnId, input: [...input] },
    });
    return driveTurnLoop(deps, extensions, turnId);
  });
}

export async function resumeTurn(deps: TurnDeps, turnId: TurnId): Promise<StopReason> {
  return withExtensions(deps, (extensions) => driveTurnLoop(deps, extensions, turnId));
}

async function driveTurnLoop(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
): Promise<StopReason> {
  let reason: StopReason = 'end_turn';
  let iteration = 0;
  let maxTokenContinuations = 0;
  try {
    // 驱动器的停止条件全部来自 turn/stopping 插件或取消信号。
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      if (isAborted(deps)) {
        reason = 'aborted';
        break;
      }
      // steer 只在步骤边界生效；不会取消上一轮已经发起的工具调用（ADR-0064）。
      if (iteration > 0 && deps.inbox?.hasSteer() === true) break;
      iteration += 1;
      const streamed = await streamOnce(deps, extensions, turnId);
      reason = streamed.stopReason;
      if (reason === 'aborted') break;
      if (streamed.error !== undefined) {
        const decision = await extensions.stepError({
          deps,
          turnId,
          error: streamed.error,
          attempt: iteration,
        });
        if (decision === 'retry') continue;
      }
      if (isAborted(deps)) {
        reason = 'aborted';
        break;
      }
      const afterStream = await requireStopping(extensions, {
        deps,
        turnId,
        phase: 'after-stream',
        iteration,
        stopReason: reason,
        callCount: streamed.calls.length,
        maxTokenContinuations,
      });
      maxTokenContinuations = afterStream.maxTokenContinuations;
      await recordNotice(deps, turnId, afterStream.notice);
      if (afterStream.action === 'stop') {
        reason = afterStream.reason;
        break;
      }
      if (afterStream.action === 'continue') continue;
      /*
       * 派发。批次之间串行、批次内部并发（ADR-0082）——只有"并行安全"的连续段
       * 会被并到一批里，写、`shell.exec`、`run_code` 一律独占一批，
       * 模型给出的先后关系因此一步没丢。
       */
      const dispatchOne = async (call: (typeof streamed.calls)[number]): Promise<void> => {
        // Code Mode 接缝按**每次调用**新建：它捕获父 callId，而那正是子调用挂靠的锚点
        const codeMode = createCodeModeSeam({ deps, extensions, turnId, parentCall: call });
        await dispatchCall(deps, extensions, turnId, call, codeMode);
      };
      for (const batch of planCallBatches(deps, streamed.calls)) {
        if (batch.length === 1 && batch[0] !== undefined) await dispatchOne(batch[0]);
        else await Promise.all(batch.map(dispatchOne));
      }

      /*
       * 取消要在派发扩展点**之前**兑现成 'aborted'。
       *
       * 扩展点派发对已 abort 的 signal 一律抛 DispatchAbortedError（ADR-0062 §二.2），
       * 而用户点停止最常见的时机恰恰是"工具正跑着"——此时若直接进 turn/stopping，
       * runTurn 会以异常收场而不是干净地返回 'aborted'，桌面那边表现为
       * sendUserMessage 报错 + Agent 循环里一条未处理的 rejection。
       * 停止是驱动器的固有责任（ADR-0055 §四），不能指望插件替它兜。
       */
      if (isAborted(deps)) {
        reason = 'aborted';
        break;
      }
      const afterTools = await requireStopping(extensions, {
        deps,
        turnId,
        phase: 'after-tools',
        iteration,
        stopReason: reason,
        callCount: streamed.calls.length,
        maxTokenContinuations,
      });
      maxTokenContinuations = afterTools.maxTokenContinuations;
      await recordNotice(deps, turnId, afterTools.notice);
      if (afterTools.action === 'stop') {
        reason = afterTools.reason;
        break;
      }
    }
  } finally {
    await deps.runtime.record({ type: 'turn.end', turnId, payload: { turnId, reason } });
  }
  return reason;
}

/*
 * 走一次函数调用是刻意的：`aborted` 会在 await 之间被异步改写，而 TS 的控制流分析
 * 会把循环顶部那次检查的结果一路窄化下去，导致后面两处守卫被判成"不可能成立"。
 */
const isAborted = (deps: TurnDeps): boolean => deps.signal?.aborted === true;

async function requireStopping(
  extensions: TurnExtensionHost,
  input: Parameters<TurnExtensionHost['stopping']>[0],
): Promise<NonNullable<Awaited<ReturnType<TurnExtensionHost['stopping']>>>> {
  const decision = await extensions.stopping(input);
  if (decision === undefined) throw new Error('缺少必需的 turn/stopping 兜底插件。');
  return decision;
}

async function recordNotice(
  deps: TurnDeps,
  turnId: TurnId,
  notice: { readonly code: string; readonly message: string } | undefined,
): Promise<void> {
  if (notice === undefined) return;
  await deps.runtime.record({
    type: 'notice.posted',
    turnId,
    payload: { level: 'warn', ...notice },
  });
}

async function withExtensions<T>(
  deps: TurnDeps,
  run: (extensions: TurnExtensionHost) => Promise<T>,
): Promise<T> {
  if (deps.extensions !== undefined) return run(deps.extensions);
  const defaults = await createDefaultTurnExtensions();
  try {
    return await run(defaults.host);
  } finally {
    await defaults.dispose();
  }
}
