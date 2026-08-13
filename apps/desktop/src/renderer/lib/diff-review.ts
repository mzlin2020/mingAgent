import { reviewHunksOfFile } from '@xm/contracts';
import type { EditProposalState } from '@xm/kernel';

export const MAX_RENDERED_DIFF_LINES = 400;

export function latestPendingProposal(
  proposals: readonly EditProposalState[],
): EditProposalState | undefined {
  return proposals.findLast((item) => item.appliedAt === undefined && item.reviewedAt === undefined);
}

export function boundedDiff(diff: string): { readonly lines: readonly string[]; readonly truncated: boolean } {
  const lines = diff.split('\n');
  return {
    lines: lines.slice(0, MAX_RENDERED_DIFF_LINES),
    truncated: lines.length > MAX_RENDERED_DIFF_LINES,
  };
}

export function allHunkIds(item: EditProposalState): string[] {
  return item.proposal.files.flatMap((file, index) =>
    reviewHunksOfFile(file, index).map((hunk) => hunk.hunkId),
  );
}
