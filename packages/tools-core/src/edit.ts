import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  EditProposal,
  newEditProposalId,
  type EditProposal as Proposal,
  type EditProposalId,
  type EditReplacement,
  type SessionId,
  type ToolProgress,
} from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { writeTextAtomic } from './fs-write.js';

export const EDIT_PREVIEW = 'edit.preview';
export const EDIT_APPLY = 'edit.apply';

const ReplacementInput = z.strictObject({
  oldText: z.string().min(1).describe('必须精确匹配的旧文本'),
  newText: z.string().describe('替换后的文本'),
  expectedMatches: z.number().int().positive().default(1).describe('期望精确命中次数'),
});
const PreviewFileInput = z.strictObject({
  path: z.string().min(1),
  replacements: z.array(ReplacementInput).min(1).max(100),
});
const PreviewInput = z.strictObject({
  files: z.array(PreviewFileInput).min(1).max(100),
});
const ApplyFileInput = z.strictObject({
  path: z.string().min(1),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const ApplyInput = z.strictObject({
  proposalId: z.uuid().brand<'EditProposalId'>(),
  files: z.array(ApplyFileInput).min(1).max(100),
});

export interface EditProposalAccess {
  save(sessionId: SessionId, proposal: Proposal): Promise<void>;
  get(
    sessionId: SessionId,
    proposalId: EditProposalId,
  ): Promise<{ readonly proposal: Proposal; readonly applied: boolean } | undefined>;
  markApplied(sessionId: SessionId, proposalId: EditProposalId): Promise<void>;
}

export interface EditPreviewFile {
  readonly path: string;
  readonly replacements: readonly EditReplacement[];
}

export async function createEditProposal(
  input: readonly EditPreviewFile[],
  signal?: { readonly aborted: boolean },
): Promise<Proposal> {
  assertUniquePaths(input.map((file) => file.path));
  const files = [];
  for (const [fileIndex, file] of input.entries()) {
    if (signal?.aborted === true) throw new Error('编辑预览已取消。');
    const beforeBytes = await readFile(file.path);
    const before = decodeUtf8(beforeBytes, file.path);
    let after = before;
    const hunks = [];
    for (const [replacementIndex, replacement] of file.replacements.entries()) {
      const next = applyReplacements(after, [replacement], file.path);
      hunks.push({
        hunkId: `${String(fileIndex)}:${String(replacementIndex)}`,
        replacementIndexes: [replacementIndex],
        diff: unifiedDiff(file.path, after, next),
      });
      after = next;
    }
    files.push({
      path: file.path,
      beforeHash: hash(beforeBytes),
      afterHash: hash(Buffer.from(after, 'utf8')),
      replacements: file.replacements,
      diff: unifiedDiff(file.path, before, after),
      hunks,
    });
  }
  return EditProposal.parse({ proposalId: newEditProposalId(), files });
}

export const editPreviewTool = (access: EditProposalAccess): RegisteredTool =>
  defineTool({
    name: EDIT_PREVIEW,
    group: 'edit',
    description:
      '预览一个或多个文件的精确字符串替换；每条替换必须给出旧文本和期望命中数。只生成 unified diff，不写盘。',
    inputSchema: PreviewInput,
    risk: 'low',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['files[].path'],
    resources: (input) => input.files.map((file) => ({ kind: 'path', mode: 'read', glob: file.path })),
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const proposal = await createEditProposal(input.files, ctx.signal);
      await access.save(ctx.sessionId, proposal);
      yield {
        kind: 'result',
        forModel: [{ type: 'text', text: JSON.stringify(proposal) }],
      };
    },
  });

export const editApplyTool = (
  access: EditProposalAccess,
  writeFile: (path: string, content: string) => Promise<void> = writeTextAtomic,
): RegisteredTool =>
  defineTool({
    name: EDIT_APPLY,
    group: 'edit',
    description:
      '应用 edit.preview 生成的提案。必须原样传回 proposalId 及每个文件的 path/beforeHash；内容漂移时零文件写入。',
    inputSchema: ApplyInput,
    risk: 'medium',
    capabilities: ['fs.read', 'fs.write'],
    concurrency: 'exclusive',
    pathInputs: ['files[].path'],
    resources: (input) => input.files.map((file) => ({ kind: 'path', mode: 'write', glob: file.path })),
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const state = await access.get(ctx.sessionId, input.proposalId);
      if (state === undefined) throw new Error('找不到当前会话中的编辑提案。');
      if (state.applied) {
        yield result(`编辑提案 ${input.proposalId} 已应用，无需重复执行。`);
        return;
      }
      assertApplyInput(state.proposal, input.files);
      const prepared = await prepareApply(state.proposal);
      if (prepared === 'already-applied') {
        await access.markApplied(ctx.sessionId, input.proposalId);
        yield result(`编辑提案 ${input.proposalId} 已在磁盘生效，已补记完成事件。`);
        return;
      }

      for (const file of prepared) {
        if (ctx.signal.aborted) throw new Error('应用编辑提案前已取消，尚未写盘。');
        await writeFile(file.path, file.content);
      }
      await access.markApplied(ctx.sessionId, input.proposalId);
      yield result(`已应用编辑提案 ${input.proposalId}：${String(prepared.length)} 个文件。`);
    },
  });

async function prepareApply(
  proposal: Proposal,
): Promise<readonly { readonly path: string; readonly content: string }[] | 'already-applied'> {
  const current = await Promise.all(
    proposal.files.map(async (file) => {
      const bytes = await readFile(file.path);
      return { file, bytes, hash: hash(bytes), text: decodeUtf8(bytes, file.path) };
    }),
  );
  if (current.every((item) => item.hash === item.file.afterHash)) return 'already-applied';
  const drifted = current.filter((item) => item.hash !== item.file.beforeHash);
  if (drifted.length > 0) {
    throw new Error(`内容已漂移，零文件写入：${drifted.map((item) => item.file.path).join('、')}`);
  }
  return current.map(({ file, text }) => {
    const content = applyReplacements(text, file.replacements, file.path);
    if (hash(Buffer.from(content, 'utf8')) !== file.afterHash) {
      throw new Error(`提案重算结果不一致，零文件写入：${file.path}`);
    }
    return { path: file.path, content };
  });
}

function assertApplyInput(
  proposal: Proposal,
  input: readonly { readonly path: string; readonly beforeHash: string }[],
): void {
  assertUniquePaths(input.map((file) => file.path));
  const expected = new Map(proposal.files.map((file) => [file.path, file.beforeHash]));
  if (
    input.length !== expected.size ||
    input.some((file) => expected.get(file.path) !== file.beforeHash)
  ) {
    throw new Error('应用请求的路径或 beforeHash 与持久化提案不一致。');
  }
}

function applyReplacements(text: string, replacements: readonly EditReplacement[], path: string): string {
  let current = text;
  for (const replacement of replacements) {
    const matches = countOccurrences(current, replacement.oldText);
    if (matches !== replacement.expectedMatches) {
      throw new Error(
        `${path} 中旧文本期望命中 ${String(replacement.expectedMatches)} 次，实际 ${String(matches)} 次。`,
      );
    }
    current = current.split(replacement.oldText).join(replacement.newText);
  }
  return current;
}

const countOccurrences = (text: string, needle: string): number => {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
};

function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = diffLines(before);
  const newLines = diffLines(after);
  const name = path.replaceAll('\\', '/');
  return [
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${String(oldLines.length)} +1,${String(newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

const diffLines = (text: string): string[] => {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};
const decodeUtf8 = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`编辑只支持 UTF-8 文本：${path}`, { cause: error });
  }
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const assertUniquePaths = (paths: readonly string[]): void => {
  if (new Set(paths).size !== paths.length) throw new Error('同一编辑请求不能重复包含同一路径。');
};
const result = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text }],
});
