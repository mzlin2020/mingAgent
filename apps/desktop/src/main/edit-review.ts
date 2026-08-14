import { reviewHunksOfFile, type EditProposal, type EditReplacement } from '@xm/contracts';
import type { EditProposalState, ExecutionFileSystem } from '@xm/kernel';

type ProposalBuilder = (
  input: readonly { readonly path: string; readonly replacements: readonly EditReplacement[] }[],
  fs: ExecutionFileSystem,
) => Promise<EditProposal>;

const loadProposalBuilder = async (): Promise<ProposalBuilder> => {
  const moduleId = ['@xm', 'tools-core'].join('/');
  try {
    const module = await import(moduleId) as { readonly createEditProposal?: ProposalBuilder };
    if (module.createEditProposal !== undefined) return module.createEditProposal;
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
    if (!missing || !(error instanceof Error) || !error.message.includes(moduleId)) throw error;
  }
  throw new Error('内建编辑工具未安装，无法应用该历史提案。');
};

export function reviewHunkIds(item: EditProposalState): readonly string[] {
  return item.proposal.files.flatMap((file, index) =>
    reviewHunksOfFile(file, index).map((hunk) => hunk.hunkId),
  );
}

export async function prepareReviewedProposal(
  item: EditProposalState,
  selectedHunkIds: readonly string[],
  fs: ExecutionFileSystem,
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
    const currentHash = await fs.sha256(await fs.read(file.path));
    if (currentHash !== file.beforeHash) {
      throw new Error(`内容已漂移，审阅结果未应用：${file.path}`);
    }
  }
  const createEditProposal = await loadProposalBuilder();
  const derived = await createEditProposal(files, fs);
  const originalHashes = new Map(item.proposal.files.map((file) => [file.path, file.beforeHash]));
  const drifted = derived.files.find((file) => originalHashes.get(file.path) !== file.beforeHash);
  if (drifted !== undefined) throw new Error(`内容已漂移，审阅结果未应用：${drifted.path}`);
  return derived;
}
