import type { TurnId } from '@xm/contracts';
import { newCheckpointId } from '@xm/contracts';
import type { PermissionClaim, RegisteredTool, ToolContext } from '@xm/kernel';
import type { TurnDeps } from './turn-types.js';

/** Failures throw and stop execution; known unsupported snapshots emit explicit warnings. */
export async function recordTurnCheckpoint(
  deps: TurnDeps,
  turnId: TurnId,
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
