import { z } from 'zod';
import { EditProposalId } from '../base/ids.js';

export const EditReplacement = z.strictObject({
  oldText: z.string().min(1),
  newText: z.string(),
  expectedMatches: z.number().int().positive(),
});
export type EditReplacement = z.infer<typeof EditReplacement>;

export const EditHunk = z.strictObject({
  hunkId: z.string().min(1),
  replacementIndexes: z.array(z.number().int().nonnegative()).min(1),
  diff: z.string(),
});
export type EditHunk = z.infer<typeof EditHunk>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const EditProposalFile = z.strictObject({
  path: z.string().min(1),
  beforeHash: Sha256,
  afterHash: Sha256,
  replacements: z.array(EditReplacement).min(1),
  diff: z.string(),
  /** M2-d 早期提案没有该字段；M2-e 起由 preview 写入稳定 hunk。 */
  hunks: z.array(EditHunk).optional(),
});
export type EditProposalFile = z.infer<typeof EditProposalFile>;

export const EditProposal = z.strictObject({
  proposalId: EditProposalId,
  files: z.array(EditProposalFile).min(1),
});
export type EditProposal = z.infer<typeof EditProposal>;

/** 旧提案没有结构化 hunks 时，把整文件 diff 作为一个可审阅块。 */
export function reviewHunksOfFile(file: EditProposalFile, fileIndex: number): readonly EditHunk[] {
  return file.hunks ?? [{
    hunkId: `legacy:${String(fileIndex)}`,
    replacementIndexes: file.replacements.map((_replacement, index) => index),
    diff: file.diff,
  }];
}
