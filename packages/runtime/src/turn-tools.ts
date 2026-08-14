import type { PermissionRequest, PolicyVerdict, ResultBlock, TurnId } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type {
  AbortLike,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';
import {
  GatewayError,
  ToolInputError,
  claimsOfCapabilities,
  evaluate,
} from '@xm/kernel';
import type { TurnExtensionHost } from './turn-extension-host.js';
import type { ToolExecutionResult, ToolGuardResult } from './turn-events.js';
import { NEVER_TURN_ABORTS } from './turn-events.js';
import { isExecutionReceipt, issueExecutionReceipt } from './turn-receipt.js';
import { turnAvailabilityContext } from './turn-request.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

export async function dispatchCall(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
  call: PendingCall,
): Promise<void> {
  const prepared = await prepareCall(deps, turnId, call);
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
    await failCall(deps, turnId, call, asInternal(error));
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
    await failCall(
      deps,
      turnId,
      call,
      xmError('policy_denied', 'tool/pre-execute 试图绕过或翻案终局权限判定。'),
    );
    return;
  }
  if (guarded.verdict.effect === 'deny') {
    await recordDenial(deps, turnId, call, prepared.tool, guarded);
    await failCall(deps, turnId, call, xmError('policy_denied', guarded.verdict.reason));
    return;
  }
  await executeCall(deps, extensions, turnId, call, prepared);
}

interface PreparedCall {
  readonly tool: RegisteredTool;
  readonly input: unknown;
  readonly ctx: ToolContext;
  readonly claims: readonly PermissionClaim[];
}

async function prepareCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
): Promise<PreparedCall | undefined> {
  const availability = turnAvailabilityContext(deps);
  const tool =
    availability === undefined
      ? deps.tools.get(call.name)
      : deps.tools.getAvailable(call.name, availability);
  if (tool === undefined) {
    await failCall(
      deps,
      turnId,
      call,
      deps.tools.has(call.name)
        ? xmError('unsupported', `工具 "${call.name}" 已被配置禁用或当前平台不可用。`)
        : xmError('tool_not_found', `没有名为 "${call.name}" 的工具。`),
    );
    return undefined;
  }

  let input: unknown;
  try {
    input = tool.parseInput(parseArgs(call.argsJson));
  } catch (error) {
    await failCall(
      deps,
      turnId,
      call,
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
  };
  let claims = claimsOfCapabilities(tool.descriptor.capabilities, '');
  if (deps.gateway !== undefined) {
    try {
      const resolved = await deps.gateway.resolve(tool, input, ctx);
      input = resolved.input;
      claims = resolved.claims;
      if (resolved.pinnedHosts !== undefined) ctx = { ...ctx, pinnedHosts: resolved.pinnedHosts };
    } catch (error) {
      await failCall(
        deps,
        turnId,
        call,
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
    await failCall(
      deps,
      turnId,
      call,
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

function evaluateClaims(
  deps: TurnDeps,
  call: PendingCall,
  tool: RegisteredTool,
  claims: readonly PermissionClaim[],
): ToolGuardResult {
  for (const claim of claims) {
    const verdict = evaluate({
      request: requestOf(deps, call, tool, claim),
      layers: deps.layers,
      executor: deps.executor.kind,
      ...(deps.pathCaseInsensitive === undefined
        ? {}
        : { pathCaseInsensitive: deps.pathCaseInsensitive }),
    });
    if (verdict.effect === 'deny') return { verdict, deniedClaim: claim };
  }
  return {
    verdict: {
      effect: 'allow',
      ruleId: 'runtime.all-claims-allowed',
      reason: '全部权限主张均已放行。',
    },
  };
}

const requestOf = (
  deps: TurnDeps,
  call: PendingCall,
  tool: RegisteredTool,
  claim: PermissionClaim,
): PermissionRequest => ({
  requestId: deps.runtime.ids.request(),
  sessionId: deps.runtime.sessionId,
  callId: call.callId,
  capability: claim.capability,
  target: claim.target,
  risk: tool.descriptor.risk,
  reason: `工具 ${call.name} 需要「${claim.capability}」`,
  trustLevel: deps.runtime.state.untrustedContext === undefined ? 'model' : 'untrusted',
});

async function recordDenial(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  tool: RegisteredTool,
  result: ToolGuardResult,
): Promise<void> {
  const claim = result.deniedClaim;
  if (claim === undefined) return;
  const request = requestOf(deps, call, tool, claim);
  await deps.runtime.record({
    type: 'permission.request',
    turnId,
    payload: {
      requestId: request.requestId,
      callId: call.callId,
      capability: request.capability,
      target: request.target,
      risk: request.risk,
      reason: result.verdict.reason,
      trustLevel: request.trustLevel,
    },
  });
  await deps.runtime.record({
    type: 'permission.decision',
    turnId,
    payload: {
      requestId: request.requestId,
      effect: 'deny',
      scope: 'once',
      by: 'policy',
      ruleId: result.verdict.ruleId,
    },
  });
}

async function executeCall(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
  call: PendingCall,
  prepared: PreparedCall,
): Promise<void> {
  const startedAt = deps.runtime.clock.now();
  const input = { deps, turnId, call, ...prepared };
  let result: ToolExecutionResult;
  try {
    result = await extensions.execute(input, () =>
      executeToolBody(deps, turnId, call, prepared, startedAt),
    );
    result = await extensions.postExecute({ ...input, result });
  } catch (error) {
    await failCall(
      deps,
      turnId,
      call,
      xmError(
        'executor_failed',
        `无法安全执行 ${prepared.tool.descriptor.name}：${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      ),
    );
    return;
  }

  if (!isExecutionReceipt(result.receipt)) {
    await failCall(
      deps,
      turnId,
      call,
      xmError('executor_failed', 'tool/execute 返回了没有真实执行收据的结果，已按未执行处理。'),
    );
    return;
  }
  const durationMs = deps.runtime.clock.now() - startedAt;
  await deps.runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: result.error === undefined,
      durationMs,
      forModel: [...result.forModel],
      ...(result.fullRef === undefined ? {} : { fullRef: result.fullRef }),
      ...(result.error === undefined ? {} : { error: result.error }),
    },
  });
  await extensions.result({ ...input, result, durationMs });
}

async function executeToolBody(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  prepared: PreparedCall,
  startedAt: number,
): Promise<ToolExecutionResult> {
  await deps.runtime.record({
    type: 'tool.start',
    turnId,
    payload: {
      callId: call.callId,
      messageId: deps.runtime.ids.message(),
      name: call.name,
      input: prepared.input,
      risk: prepared.tool.descriptor.risk,
      capabilities: [...new Set(prepared.claims.map((claim) => claim.capability))],
    },
  });
  const receipt = issueExecutionReceipt(
    call.callId,
    startedAt,
    prepared.tool.descriptor.name,
  );
  let forModel: ResultBlock[] = [];
  let error: ReturnType<typeof xmError> | undefined;
  try {
    for await (const progress of prepared.tool.execute(prepared.input, prepared.ctx)) {
      if (progress.kind === 'progress') {
        await deps.runtime.record({
          type: 'tool.progress',
          turnId,
          payload: {
            callId: call.callId,
            ...(progress.message === undefined ? {} : { message: progress.message }),
            ...(progress.data === undefined ? {} : { data: progress.data }),
          },
        });
      } else {
        forModel = [...progress.forModel];
      }
    }
  } catch (caught) {
    error =
      caught instanceof ToolInputError
        ? xmError('invalid_input', caught.message)
        : xmError('internal', caught instanceof Error ? caught.message : String(caught));
    forModel = [{ type: 'text', text: error.message }];
  }
  return { forModel, receipt, ...(error === undefined ? {} : { error }) };
}

export async function failCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  error: ReturnType<typeof xmError>,
): Promise<void> {
  await deps.runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: false,
      durationMs: 0,
      forModel: [{ type: 'text', text: error.message }],
      error,
    },
  });
}

const parseArgs = (argsJson: string): unknown => {
  if (argsJson.trim() === '') return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
};

const asInternal = (error: unknown): ReturnType<typeof xmError> =>
  xmError('internal', error instanceof Error ? error.message : String(error));

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export type { AbortLike, PolicyVerdict };
