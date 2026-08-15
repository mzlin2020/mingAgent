import {
  EditProposal,
  newEditProposalId,
  type EditProposal as Proposal,
  type EditProposalId,
  type EditReplacement,
  type SessionId,
} from '@xm/contracts';
import type { ExecutionFileSystem } from '@xm/kernel';
import { unifiedDiff } from './diff.js';

/**
 * `edit.*` 两个工具与它们的展示投影**共用**的那一层。
 *
 * 单独成文件不是为了好看：`edit.ts` 要用 `edit-present.ts` 的投影与动作，
 * 而那些动作又要用 `createEditProposal` 去生成收窄提案——两个文件直接互相 import
 * 就是一条循环依赖，`.dependency-cruiser.cjs` 的"禁止循环依赖"当场拦下。
 * 把共用的那半沉到这里，两边各自单向依赖它。
 */

export const EDIT_PREVIEW = 'edit.preview';
export const EDIT_APPLY = 'edit.apply';

export interface EditProposalAccess {
  save(sessionId: SessionId, proposal: Proposal): Promise<void>;
  get(
    sessionId: SessionId,
    proposalId: EditProposalId,
  ): Promise<
    { readonly proposal: Proposal; readonly applied: boolean; readonly reviewed: boolean } | undefined
  >;
  markApplied(sessionId: SessionId, proposalId: EditProposalId): Promise<void>;
  /**
   * 落 `edit.reviewed`。**窄写入口，不是通用 `record()`**——与 ADR-0041 给 todo 工具的
   * 窄回调同形同理：给出通用事件入口等于让一次卡片点击能伪造 `tool.end`。
   */
  markReviewed(
    sessionId: SessionId,
    proposalId: EditProposalId,
    selectedHunkIds: readonly string[],
  ): Promise<void>;
}

export interface EditPreviewFile {
  readonly path: string;
  readonly replacements: readonly EditReplacement[];
}

/**
 * 单个可编辑文件的字节上限。
 *
 * 比 `fs.read` 的 512 KB 宽：读取可以按 offset 分段，精确编辑不行——它必须拿到全文
 * 才能算命中数和 afterHash。但仍然要有上限：`edit.preview` 一次最多 100 个文件，
 * 没有上限时一个失手的 path 就能把整份大文件（乃至一批）拉进主进程内存。
 */
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;

export async function createEditProposal(
  input: readonly EditPreviewFile[],
  fs: ExecutionFileSystem,
  signal?: { readonly aborted: boolean },
): Promise<Proposal> {
  assertUniquePaths(input.map((file) => file.path));
  const files = [];
  for (const [fileIndex, file] of input.entries()) {
    if (signal?.aborted === true) throw new Error('编辑预览已取消。');
    await assertEditableSize(fs, file.path);
    const beforeBytes = await fs.read(file.path);
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
      beforeHash: await fs.sha256(beforeBytes),
      afterHash: await fs.sha256(Buffer.from(after, 'utf8')),
      replacements: file.replacements,
      diff: unifiedDiff(file.path, before, after),
      hunks,
    });
  }
  return EditProposal.parse({ proposalId: newEditProposalId(), files });
}


export function applyReplacements(
  text: string,
  replacements: readonly EditReplacement[],
  path: string,
): string {
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

async function assertEditableSize(fs: ExecutionFileSystem, path: string): Promise<void> {
  const info = await fs.stat(path);
  if (info.size > MAX_EDIT_FILE_BYTES) {
    throw new Error(
      `${path} 共 ${String(info.size)} 字节，超过精确编辑上限 ${String(MAX_EDIT_FILE_BYTES)} 字节。`,
    );
  }
}

export const decodeUtf8 = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`编辑只支持 UTF-8 文本：${path}`, { cause: error });
  }
};

export const assertUniquePaths = (paths: readonly string[]): void => {
  if (new Set(paths).size !== paths.length) throw new Error('同一编辑请求不能重复包含同一路径。');
};

