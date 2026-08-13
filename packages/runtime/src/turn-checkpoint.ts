import type { CallId, TurnId } from '@xm/contracts';
import { newCheckpointId } from '@xm/contracts';
import type { PermissionClaim, RegisteredTool, ToolContext } from '@xm/kernel';
import type { TurnDeps } from './turn-types.js';

/** 失败即抛出并中止执行；已知不支持的快照类型只发显式告警。 */
export async function recordTurnCheckpoint(
  deps: TurnDeps,
  turnId: TurnId,
  callId: CallId,
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolContext,
  claims: readonly PermissionClaim[],
): Promise<void> {
  if (deps.checkpointer === undefined) return;

  const result = await deps.checkpointer.before(tool, input, ctx, claims);
  if (result === undefined) return;
  if (result.record !== undefined) {
    await deps.runtime.record({
      type: 'checkpoint.created',
      turnId,
      payload: {
        checkpointId: newCheckpointId(),
        kind: result.record.kind,
        ref: result.record.ref,
        label: result.record.label,
        ...(result.record.manifestRef === undefined
          ? {}
          : { manifestRef: result.record.manifestRef }),
        callId,
      },
    });
  }
  for (const warning of result.warnings) {
    await deps.runtime.record({
      type: 'notice.posted',
      turnId,
      payload: {
        level: 'warn',
        code: 'checkpoint.failed',
        message: `${tool.descriptor.name} 的部分目标没有还原点，但按既定策略继续执行：${warning}`,
      },
    });
  }
}
