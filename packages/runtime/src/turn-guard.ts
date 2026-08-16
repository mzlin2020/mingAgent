import type { PermissionRequest, TurnId } from '@xm/contracts';
import type { PermissionClaim, RegisteredTool } from '@xm/kernel';
import { evaluate } from '@xm/kernel';
import type { ToolGuardResult } from './turn-events.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

/**
 * 十二步链里判权那两步（ADR-0055 ⑤⑥）：逐条主张求值，以及被拒时**成对**落两条
 * `permission.*` 事件。
 *
 * 从 `turn-tools.ts` 拆出来是规模纪律逼的，但拆得动是因为这里自成一体：
 * 它只认 `evaluate()` 与事件流，不碰工具执行。
 *
 * ⚠️ 两条纪律钉在这个文件上：
 *
 * 1. **只有 `deny` 会落事件。** `allow` 不落——放行是常态，逐次记录会把事件流淹掉，
 *    而"为什么被拦"才是审计要回答的问题（ADR-0039 之后 `permission.*` 只剩这一个用途）。
 * 2. **`by: 'policy'`。** 判定没有第二个来源：审批已删，没有"用户点了同意"这一档。
 *    想在这里加一个"再问一次"的分支之前，先读 ADR-0039 的背景。
 */

export function evaluateClaims(
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

export async function recordDenial(
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
