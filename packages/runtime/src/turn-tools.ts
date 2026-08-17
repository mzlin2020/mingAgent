import type { PolicyVerdict, ResultBlock, TurnId } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type {
  AbortLike,
  CodeModeSeam,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';
import { GatewayError, ToolInputError, claimsOfCapabilities } from '@xm/kernel';
import type { TurnExtensionHost } from './turn-extension-host.js';
import { evaluateClaims, recordDenial } from './turn-guard.js';
import type { PreparedCall, ToolExecutionResult, ToolGuardResult } from './turn-events.js';
import { NEVER_TURN_ABORTS } from './turn-events.js';
import { isExecutionReceipt, issueExecutionReceipt } from './turn-receipt.js';
import { isModelVisible, presentationOf, turnAvailabilityContext } from './turn-request.js';
import type { CallSink } from './turn-sink.js';
import { modelCallSink } from './turn-sink.js';
import { parseToolArgs } from './turn-args.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

/** 模型发起的一次调用。记录面是 `tool.start` / `tool.end` */
export async function dispatchCall(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
  call: PendingCall,
  codeMode?: CodeModeSeam,
): Promise<void> {
  await dispatchCallWith(deps, extensions, turnId, call, modelCallSink(deps, turnId, call), codeMode);
}

/**
 * 十二步链本体（ADR-0055）。**判定与执行在这里，记录在 `sink` 里。**
 *
 * `codeMode` 只对模型发起的调用给（`run_code` 靠它跑程序）；子调用一律不给——
 * 那是"不做嵌套 `run_code`"（ADR-0061 §六）在结构上的落点，而不是一句约定。
 */
export async function dispatchCallWith(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
  call: PendingCall,
  sink: CallSink,
  codeMode?: CodeModeSeam,
  caller: 'model' | 'program' = 'model',
): Promise<void> {
  const prepared = await prepareCall(deps, call, sink, codeMode, caller);
  if (prepared === undefined) return;
  const guardInput = { deps, turnId, call, ...prepared };
  const guardState: { reached: boolean; base?: ToolGuardResult } = { reached: false };
  let guarded: ToolGuardResult;
  try {
    guarded = await extensions.preExecute(guardInput, () => {
      guardState.reached = true;
      guardState.base = evaluateClaims(deps, call, prepared.tool, prepared.claims);
      return Promise.resolve(guardState.base);
    });
  } catch (error) {
    await sink.fail(asInternal(error), prepared);
    return;
  }

  /*
   * allow 必须来自真正跑过的终局判定，且下游一旦 deny，外层不能翻回 allow。
   * 这两条运行时检查覆盖 JS 插件与恶意类型断言，不把安全性只押在 TypeScript 上。
   */
  if (
    guarded.verdict.effect === 'allow' &&
    (!guardState.reached || guardState.base?.verdict.effect !== 'allow')
  ) {
    await sink.fail(
      xmError('policy_denied', 'tool/pre-execute 试图绕过或翻案终局权限判定。'),
      prepared,
    );
    return;
  }
  if (guarded.verdict.effect === 'deny') {
    await recordDenial(deps, turnId, call, prepared.tool, guarded);
    await sink.fail(xmError('policy_denied', guarded.verdict.reason), prepared);
    return;
  }
  await executeCall(deps, extensions, turnId, call, prepared, sink);
}

async function prepareCall(
  deps: TurnDeps,
  call: PendingCall,
  sink: CallSink,
  codeMode: CodeModeSeam | undefined,
  caller: 'model' | 'program',
): Promise<PreparedCall | undefined> {
  const availability = turnAvailabilityContext(deps);
  /*
   * ① 工具查找。呈现模式只对模型生效（ADR-0061 §二）：`code` 模式下模型点名
   * 别的工具，在这里就解析成"没有这个工具"——**判定之前**，不产生一条被拒绝的调用。
   * 程序发起的子调用走 `caller: 'program'`，不受它约束。
   */
  const hidden = caller === 'model' && !isModelVisible(presentationOf(deps), call.name);
  const tool =
    hidden ? undefined
    : availability === undefined
      ? deps.tools.get(call.name)
      : deps.tools.getAvailable(call.name, availability);
  if (tool === undefined) {
    await sink.fail(
      !hidden && deps.tools.has(call.name)
        ? xmError('unsupported', `工具 "${call.name}" 已被配置禁用或当前平台不可用。`)
        : xmError('tool_not_found', `没有名为 "${call.name}" 的工具。`),
    );
    return undefined;
  }

  /*
   * ② 入参解码 + 校验。解不开的 JSON **不当成空入参**（地基复审四 C1）：
   * 那会让入参全可选的工具带着一整套默认值照常执行，而模型与审计都看不出
   * 参数曾经坏过。理由与形状见 `turn-args.ts`。
   */
  const args = parseToolArgs(call.argsJson);
  if (!args.ok) {
    await sink.fail(xmError('invalid_input', args.message));
    return undefined;
  }

  let input: unknown;
  try {
    input = tool.parseInput(args.value);
  } catch (error) {
    await sink.fail(
      error instanceof ToolInputError
        ? error.asXmError
        : xmError('invalid_input', error instanceof Error ? error.message : String(error)),
    );
    return undefined;
  }

  let ctx: ToolContext = {
    sessionId: deps.runtime.sessionId,
    callId: call.callId,
    signal: deps.signal ?? NEVER_TURN_ABORTS,
    cwd: deps.runtime.state.cwd,
    executor: deps.executor,
    ...(codeMode === undefined ? {} : { codeMode }),
  };
  let claims = claimsOfCapabilities(tool.descriptor.capabilities, '');
  if (deps.gateway !== undefined) {
    try {
      const resolved = await deps.gateway.resolve(tool, input, ctx);
      input = resolved.input;
      claims = resolved.claims;
      if (resolved.pinnedHosts !== undefined) ctx = { ...ctx, pinnedHosts: resolved.pinnedHosts };
    } catch (error) {
      await sink.fail(
        error instanceof GatewayError
          ? error.asXmError
          : xmError('invalid_input', error instanceof Error ? error.message : String(error)),
      );
      return undefined;
    }
  }

  const missing = tool.descriptor.capabilities.filter(
    (capability) => !claims.some((claim) => claim.capability === capability),
  );
  if (missing.length > 0) {
    await sink.fail(
      xmError(
        'invalid_input',
        `工具 ${call.name} 声明了能力「${missing.join('、')}」，` +
          '但网关没有产出对应主张；为避免规则整体失效，拒绝执行。',
      ),
    );
    return undefined;
  }
  return { tool, input: deepFreeze(input), ctx: Object.freeze(ctx), claims };
}

async function executeCall(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
  call: PendingCall,
  prepared: PreparedCall,
  sink: CallSink,
): Promise<void> {
  const startedAt = deps.runtime.clock.now();
  const input = { deps, turnId, call, ...prepared };
  let result: ToolExecutionResult;
  try {
    result = await extensions.execute(input, (signal) =>
      executeToolBody(deps, call, prepared, startedAt, signal, sink),
    );
    result = await extensions.postExecute({ ...input, result });
  } catch (error) {
    await sink.fail(
      xmError(
        'executor_failed',
        `无法安全执行 ${prepared.tool.descriptor.name}：${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      ),
      prepared,
    );
    return;
  }

  if (!isExecutionReceipt(result.receipt, call.callId, prepared.tool.descriptor.name)) {
    await sink.fail(
      xmError('executor_failed', 'tool/execute 返回了没有真实执行收据的结果，已按未执行处理。'),
      prepared,
    );
    return;
  }
  const durationMs = deps.runtime.clock.now() - startedAt;
  await sink.end(prepared, result, durationMs);
  await extensions.result({ ...input, result, durationMs });
}

async function executeToolBody(
  deps: TurnDeps,
  call: PendingCall,
  prepared: PreparedCall,
  startedAt: number,
  signal: AbortLike,
  sink: CallSink,
): Promise<ToolExecutionResult> {
  /*
   * ⑧ 唯一被允许改的东西在这里落地：环绕插件收紧过的 signal 换进 ToolContext。
   * 其余字段一律沿用 prepareCall 的产物——尤其 `input`，它在 ④ 之后就冻结了，
   * 换掉它等于重开判定与执行之间的 TOCTOU 窗口（ADR-0018）。
   */
  const ctx = signal === prepared.ctx.signal ? prepared.ctx : Object.freeze({ ...prepared.ctx, signal });
  await sink.start(prepared);
  const receipt = issueExecutionReceipt(
    call.callId,
    startedAt,
    prepared.tool.descriptor.name,
  );
  let forModel: ResultBlock[] = [];
  let presentation: unknown;
  let output: unknown;
  let error: ReturnType<typeof xmError> | undefined;
  try {
    for await (const progress of prepared.tool.execute(prepared.input, ctx)) {
      if (progress.kind === 'progress') {
        await sink.progress(progress);
      } else {
        forModel = [...progress.forModel];
        presentation = progress.presentation;
        // 规范值不落库，工具 yield 的这一刻是它唯一的校验关口（ADR-0071）
        output = prepared.tool.parseOutput(progress.output);
      }
    }
  } catch (caught) {
    error =
      caught instanceof ToolInputError
        ? xmError('invalid_input', caught.message)
        : xmError('internal', caught instanceof Error ? caught.message : String(caught));
    forModel = [{ type: 'text', text: error.message }];
  }
  return {
    forModel,
    receipt,
    ...(presentation === undefined ? {} : { presentation }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  };
}

export async function failCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  error: ReturnType<typeof xmError>,
): Promise<void> {
  await modelCallSink(deps, turnId, call).fail(error);
}

const asInternal = (error: unknown): ReturnType<typeof xmError> =>
  xmError('internal', error instanceof Error ? error.message : String(error));

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export type { AbortLike, PermissionClaim, PolicyVerdict, RegisteredTool };
