import type { BlobRef, ResultBlock } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { truncateResult } from '@xm/kernel';
import type { TurnDeps } from './turn-types.js';

/** 结果上限统一在这里施加；工具无法选择不被截断。 */
export async function capToolResult(
  deps: TurnDeps,
  blocks: readonly ResultBlock[],
  tool: RegisteredTool,
): Promise<{ forModel: ResultBlock[]; fullRef?: BlobRef }> {
  const limits = tool.descriptor.resultLimits;
  const probe = truncateResult(blocks, limits);
  if (!probe.truncated) return { forModel: probe.blocks };
  if (deps.blobs === undefined) return { forModel: probe.blocks };

  const full = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const ref = await deps.blobs.put(new TextEncoder().encode(full), 'text/plain');
  return { forModel: truncateResult(blocks, limits, ref).blocks, fullRef: ref };
}
