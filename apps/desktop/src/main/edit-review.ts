import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reviewHunksOfFile, type EditProposal } from '@xm/contracts';
import type { EditProposalState } from '@xm/kernel';
import { createEditProposal } from '@xm/tools-core';

export function reviewHunkIds(item: EditProposalState): readonly string[] {
  return item.proposal.files.flatMap((file, index) =>
    reviewHunksOfFile(file, index).map((hunk) => hunk.hunkId),
  );
}

export async function prepareReviewedProposal(
  item: EditProposalState,
  selectedHunkIds: readonly string[],
): Promise<EditProposal | undefined> {
  if (new Set(selectedHunkIds).size !== selectedHunkIds.length) {
    throw new Error('diff 审阅结果包含重复 hunk。');
  }
  const known = new Set(reviewHunkIds(item));
  if (selectedHunkIds.some((id) => !known.has(id))) {
    throw new Error('diff 审阅结果包含不属于该提案的 hunk。');
  }
  if (selectedHunkIds.length === 0) return undefined;

  const selected = new Set(selectedHunkIds);
  const files = item.proposal.files.flatMap((file, fileIndex) => {
    const indexes = new Set(
      reviewHunksOfFile(file, fileIndex)
        .filter((hunk) => selected.has(hunk.hunkId))
        .flatMap((hunk) => hunk.replacementIndexes),
    );
    const replacements = file.replacements.filter((_replacement, index) => indexes.has(index));
    return replacements.length === 0 ? [] : [{ path: file.path, replacements }];
  });
  const selectedPaths = new Set(files.map((file) => file.path));
  for (const file of item.proposal.files) {
    if (!selectedPaths.has(file.path)) continue;
    const currentHash = createHash('sha256').update(await readFile(file.path)).digest('hex');
    if (currentHash !== file.beforeHash) {
      throw new Error(`内容已漂移，审阅结果未应用：${file.path}`);
    }
  }
  const derived = await createEditProposal(files);
  const originalHashes = new Map(item.proposal.files.map((file) => [file.path, file.beforeHash]));
  const drifted = derived.files.find((file) => originalHashes.get(file.path) !== file.beforeHash);
  if (drifted !== undefined) throw new Error(`内容已漂移，审阅结果未应用：${drifted.path}`);
  return derived;
}
