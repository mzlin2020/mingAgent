import type { CallId, TurnId, XmError } from '@xm/contracts';
import type {
  AbortLike,
  CodeBindingCall,
  CodeBindingResult,
  CodeDispatchRecord,
  CodeModeSeam,
} from '@xm/kernel';
import { RUN_CODE } from './code-sdk.js';
import { linkAbort } from './turn-abort.js';
import { parseToolArgs } from './turn-args.js';
import type { PreparedCall, ToolExecutionResult } from './turn-events.js';
import type { TurnExtensionHost } from './turn-extension-host.js';
import type { CallSink } from './turn-sink.js';
import { dispatchCallWith } from './turn-tools.js';
import { turnAvailabilityContext } from './turn-request.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

/**
 * Code Mode 的子调用派发（ADR-0061 §一 / ADR-0072）。
 *
 * 程序调一次工具，这里就**从头走一遍完整十二步链**——同一个 `dispatchCallWith`、
 * 同一个网关、同一份 `evaluate()`。父 `run_code` 被允许**不代表**它内部的 `fs.write`
 * 被允许；复用父判定是 ADR-0061 明写的一级缺陷。
 *
 * 两处与模型发起的调用不同，都在记录面（`CallSink`）上：
 *
 * 1. 落的是一条 `tool.code.dispatch`，不是 `tool.start` / `tool.end`。
 *    子调用的返回值不进模型请求（ADR-0061 §四），那条事件里**没有 `forModel` 字段**。
 * 2. 被拒绝时不让整段程序死掉：拒绝理由变成客体域里的一个异常，程序可以 catch 并调整。
 *    **但事件照落**——程序 catch 掉了，审计里也看得见。
 */

export interface CodeModeSeamInput {
  readonly deps: TurnDeps;
  readonly extensions: TurnExtensionHost;
  readonly turnId: TurnId;
  readonly parentCall: PendingCall;
}

/** 没装 Code Mode（`deps.codeRuntime` 缺席）就返回 undefined——`ctx.codeMode` 跟着缺席 */
export function createCodeModeSeam(input: CodeModeSeamInput): CodeModeSeam | undefined {
  const runtime = input.deps.codeRuntime;
  if (runtime === undefined) return undefined;
  const log: CodeDispatchRecord[] = [];
  return {
    runtime,
    bindings: () => codeBindingNames(input.deps),
    dispatched: () => log,
    now: () => input.deps.runtime.clock.now(),
    /*
     * 种子取父调用的 `callId`。确定性 profile 下 `callId` 本身是可预测的，
     * 于是程序里的随机序列也可预测——快照验收要的正是这个性质（ADR-0066）。
     */
    randomSeed: () => input.parentCall.callId,
    dispatch: (call, signal) => dispatchCodeCall(input, log, call, signal),
  };
}

/** 这一次调用能给程序装哪些绑定：可用的工具，去掉 `run_code` 自己（不做嵌套） */
export function codeBindingNames(deps: TurnDeps): readonly string[] {
  const availability = turnAvailabilityContext(deps);
  const descriptors =
    availability === undefined ? deps.tools.descriptors() : deps.tools.descriptors(availability);
  return descriptors.map((descriptor) => descriptor.name).filter((name) => name !== RUN_CODE);
}

async function dispatchCodeCall(
  input: CodeModeSeamInput,
  log: CodeDispatchRecord[],
  call: CodeBindingCall,
  /** 这一次 `run_code` 的运行域。程序被终止时它 abort（C2） */
  runSignal: AbortLike,
): Promise<CodeBindingResult> {
  const index = log.length;
  const sub: PendingCall = {
    callId: input.deps.runtime.ids.call(),
    name: call.name,
    argsJson: encodeArgs(call.input),
  };
  const sink = codeDispatchSink(input, index, sub);

  /*
   * 已经终止了就**不派发**（地基复审四 C2）。
   *
   * 与"派发之后再取消"不是一回事：这条挡的是 abort 与 postMessage 之间那个窗口里
   * 送进来的调用。那时程序已经被判定失败，再起一个 `shell.exec` 纯属白做。
   */
  if (runSignal.aborted) {
    const message = '这一次 run_code 已经结束（超时或被取消），子调用没有派发。';
    log.push({ index, name: call.name, ok: false, message });
    return { ok: false, message, code: 'aborted' };
  }

  /*
   * 子调用的取消信号是**两条的并集**：这一轮被停（`deps.signal`）要停，
   * 这段程序被终止（`runSignal`）也要停。只接前者的话，一个墙钟超时的程序
   * 派发出去的工具会一直跑到自己结束——十二步链一步不少地跑完，
   * 而模型早已被告知这段程序失败了。
   */
  const linked = linkAbort(input.deps.signal, runSignal);
  try {
    // codeMode 不往下传：程序里再调一次 run_code 拿不到运行时（ADR-0061 §六）
    await dispatchCallWith(
      { ...input.deps, signal: linked.signal },
      input.extensions, input.turnId, sub, sink.sink, undefined, 'program',
    );
  } finally {
    linked.dispose();
  }
  const outcome = sink.outcome();
  log.push({
    index,
    name: call.name,
    ok: outcome.ok,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
  });
  return outcome;
}

interface CodeDispatchSink {
  readonly sink: CallSink;
  outcome(): CodeBindingResult;
}

function codeDispatchSink(
  input: CodeModeSeamInput,
  index: number,
  sub: PendingCall,
): CodeDispatchSink {
  const state: { result?: CodeBindingResult } = {};

  const record = async (options: {
    readonly prepared?: PreparedCall;
    readonly ok: boolean;
    readonly durationMs: number;
    readonly error?: XmError;
  }): Promise<void> => {
    const descriptor = options.prepared?.tool.descriptor;
    await input.deps.runtime.record({
      type: 'tool.code.dispatch',
      turnId: input.turnId,
      payload: {
        callId: sub.callId,
        parentCallId: input.parentCall.callId,
        index,
        name: sub.name,
        // 网关规范化并回写之后的那一份；没走到那一步就记程序原样给的
        input: options.prepared?.input ?? decodeArgs(sub.argsJson),
        ...(descriptor === undefined ? {} : { risk: descriptor.risk }),
        ...(options.prepared === undefined
          ? {}
          : {
              capabilities: [
                ...new Set(options.prepared.claims.map((claim) => claim.capability)),
              ],
            }),
        ok: options.ok,
        durationMs: options.durationMs,
        ...(options.error === undefined ? {} : { error: options.error }),
      },
    });
  };

  return {
    sink: {
      async fail(error, prepared) {
        state.result = { ok: false, message: error.message, code: error.code };
        await record({ ok: false, durationMs: 0, error, ...(prepared === undefined ? {} : { prepared }) });
      },

      /*
       * 子调用不落 `tool.start`，也不转发 `tool.progress`。
       *
       * 进度是给人看的实时反馈，而程序里的一次子调用没有对应的 UI 位置——
       * `run_code` 那张卡片显示的是"第几步调了什么"，不是某一步内部的百分比。
       * 真要显示，该由 `run_code` 自己的进度流表达，而不是让子调用冒充一次顶层调用。
       */
      start: () => Promise.resolve(),
      progress: () => Promise.resolve(),

      async end(prepared, result: ToolExecutionResult, durationMs) {
        const failure = result.error;
        state.result =
          failure === undefined
            ? { ok: true, ...(result.output === undefined ? {} : { value: result.output }) }
            : { ok: false, message: failure.message, code: failure.code };
        await record({
          prepared,
          ok: failure === undefined,
          durationMs,
          ...(failure === undefined ? {} : { error: failure }),
        });
      },
    },

    /*
     * 链条一步没走到就返回时（理论上不会——`fail` 与 `end` 必有其一）这里兜一个失败。
     * 兜的是"什么都没发生"，绝不能兜成"成功但没有返回值"：那会让程序把一次没执行的
     * 调用当成执行过了。
     */
    outcome: () =>
      state.result ?? { ok: false, message: `子调用 ${sub.name} 没有产生任何结果。` },
  };
}

/**
 * 程序给的入参 → `argsJson`。
 *
 * 序列化不了时**不退回 `{}`**（同 C1 的理由）：那会让一次"参数根本没送到"的子调用
 * 变成一次"没带参数"的子调用照常执行。返回一段故意不合法的 JSON，让它在
 * `prepareCall` 的入参解码那一步就被拒，理由一路传回程序里那个 catch。
 */
const UNSERIALIZABLE_ARGS = '<入参无法序列化>';

const encodeArgs = (input: unknown): string => {
  try {
    const json = JSON.stringify(input ?? {});
    return typeof json === 'string' ? json : UNSERIALIZABLE_ARGS;
  } catch {
    return UNSERIALIZABLE_ARGS;
  }
};

/** 审计事件里那份入参。走到这里说明网关没接手，记程序原样给的——解不开就记原文 */
const decodeArgs = (argsJson: string): unknown => {
  const parsed = parseToolArgs(argsJson);
  return parsed.ok ? parsed.value : argsJson;
};

export type { CallId };
