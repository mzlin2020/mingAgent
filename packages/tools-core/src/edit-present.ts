import { z } from 'zod';
import { reviewHunksOfFile } from '@xm/contracts';
import type { EditProposal, ToolCard } from '@xm/contracts';
import type { ExecutionFileSystem, ToolActionSpec, ToolResultOutcome } from '@xm/kernel';
import type { EditPreviewFile, EditProposalAccess } from './edit-core.js';
import { EDIT_APPLY, createEditProposal } from './edit-core.js';

/**
 * `edit.preview` 的展示投影与卡片动作（ADR-0058 / ADR-0065）。
 *
 * 这里是 M2-e 那条 `edit-review` 专用通道退役后的落点：**展示**由 diff 卡片承担，
 * **交互**由卡片动作承担，两半都不再要求渲染层认识 `edit` 这个工具。
 * 权限语义一个字没改（ADR-0045）——逐块选择照旧生成收窄提案、照旧复用
 * `edit.apply` 的完整分发路径，只是那条路径现在从一次点击开始，而不是从一个专用 IPC 开始。
 */

/**
 * 落库的最小事实：每个文件的可审阅块。
 *
 * **不落整文件对倒**——ADR-0050 刚因为"整文件前后两份全文"收窄过模型可见结果，
 * 展示数据走同一个方向。`hunkId` 同时是逐块接受时的选择项 id，
 * 它必须与 `reviewHunksOfFile()` 算出来的一致，否则选择集对不上提案。
 */
export const EditPresentation = z.strictObject({
  proposalId: z.string().min(1),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      hunks: z.array(z.strictObject({ hunkId: z.string().min(1), patch: z.string() })),
    }),
  ),
});
export type EditPresentation = z.infer<typeof EditPresentation>;

/** 从提案投影出落库事实。在 `execute` 里求值一次，不是纯函数路径的一部分 */
export const editPresentationOf = (proposal: EditProposal): EditPresentation => ({
  proposalId: proposal.proposalId,
  files: proposal.files.map((file, index) => ({
    path: file.path,
    hunks: reviewHunksOfFile(file, index).map((hunk) => ({
      hunkId: hunk.hunkId,
      patch: hunk.diff,
    })),
  })),
});

/**
 * 挂起卡片。调用时刻**只有入参**：知道要动哪些文件、每个文件几处替换，
 * 不知道 diff 长什么样——投影函数不许读盘，所以这里老实显示通用卡片。
 */
export const presentPreviewCall = (input: {
  readonly files: readonly { readonly path: string; readonly replacements: readonly unknown[] }[];
}): ToolCard => ({
  kind: 'generic',
  title: '生成编辑提案',
  summary: `正在预览 ${String(input.files.length)} 个文件的改动…`,
  locations: input.files.map((file) => ({ path: file.path })),
});

/** 完成卡片：逐块可选的 diff + 两个动作。畸形或缺席的落库事实一律降级为通用卡片 */
export const presentPreviewResult = (
  _input: unknown,
  outcome: ToolResultOutcome<EditPresentation>,
): ToolCard | undefined => {
  const meta = outcome.presentation;
  if (!outcome.ok || meta === undefined) return undefined;
  const hunks = meta.files.reduce((sum, file) => sum + file.hunks.length, 0);
  return {
    kind: 'diff',
    summary: `${String(meta.files.length)} 个文件、${String(hunks)} 个改动块待审阅`,
    files: meta.files.map((file) => ({ kind: 'hunks', path: file.path, hunks: file.hunks })),
    actions: [
      { actionId: 'accept', label: '应用选中', payload: 'selection', emphasis: 'primary' },
      { actionId: 'reject-all', label: '拒绝全部', payload: 'none', emphasis: 'secondary' },
    ],
  };
};

interface PreviewInput { readonly files: readonly EditPreviewFile[] }

/**
 * 逐块接受/拒绝。
 *
 * ⚠️ 它产出的是一次**新的 `edit.apply` 调用请求**，不是一次写入。
 * 那次调用照常走网关规范化 → 红线判定 → 分层求值——**点了"接受"不等于批准了写入**
 * （ADR-0045 / ADR-0065 §三）。载荷里塞一个越界路径也没有用：路径来自
 * 已落库的提案，不来自渲染层送上来的东西，而它照样要再过一次闸门。
 */
export const previewActions = (
  access: EditProposalAccess,
): Readonly<Record<string, ToolActionSpec<PreviewInput, EditPresentation>>> => ({
  accept: {
    label: '应用选中',
    payload: 'selection',
    emphasis: 'primary',
    prepare: async ({ presentation, payload, ctx }) => {
      const selected = 'selected' in payload ? payload.selected : [];
      const proposal = await claimForReview(access, ctx.sessionId, presentation, selected);
      if (selected.length === 0) return undefined;
      const derived = await narrow(proposal, selected, ctx.executor.fs);
      await access.save(ctx.sessionId, derived);
      return {
        name: EDIT_APPLY,
        args: {
          proposalId: derived.proposalId,
          files: derived.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
        },
      };
    },
  },
  'reject-all': {
    label: '拒绝全部',
    payload: 'none',
    prepare: async ({ presentation, ctx }) => {
      await claimForReview(access, ctx.sessionId, presentation, []);
      return undefined;
    },
  },
});

/**
 * 认领这次审阅：提案必须存在、未处理，选择集必须全部属于它。
 *
 * 认领在**做任何事之前**落 `edit.reviewed`——它同时是幂等闸门：
 * 卡片是入参与落库事实的纯投影，不会因为提案被处理过就自动灰掉按钮，
 * 所以"点第二次"必须在这里被挡住，而不是靠 UI 记得禁用。
 */
async function claimForReview(
  access: EditProposalAccess,
  sessionId: Parameters<EditProposalAccess['get']>[0],
  presentation: EditPresentation | undefined,
  selected: readonly string[],
): Promise<EditProposal> {
  if (presentation === undefined) throw new Error('这次调用没有可审阅的改动。');
  const proposalId = presentation.proposalId as Parameters<EditProposalAccess['get']>[1];
  const state = await access.get(sessionId, proposalId);
  if (state === undefined) throw new Error('找不到当前会话中的编辑提案。');
  if (state.applied || state.reviewed) throw new Error('该编辑提案已处理。');
  if (new Set(selected).size !== selected.length) throw new Error('审阅结果包含重复的改动块。');
  const known = new Set(presentation.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkId)));
  if (selected.some((id) => !known.has(id))) {
    throw new Error('审阅结果包含不属于该提案的改动块。');
  }
  await access.markReviewed(sessionId, proposalId, selected);
  return state.proposal;
}

/**
 * 把选中的块收窄成一份新提案（ADR-0050）。
 *
 * 两次漂移校验都保留：先按原提案的 `beforeHash` 核一遍当前磁盘内容，
 * 重算出派生提案后再核一遍——**内容漂移时零文件写入**。
 * 这段逻辑是从 `apps/desktop/src/main/edit-review.ts` 原样搬过来的，
 * 搬家不改行为；变化的只是它现在住在工具旁边，而不是外壳里。
 */
async function narrow(
  proposal: EditProposal,
  selected: readonly string[],
  fs: ExecutionFileSystem,
): Promise<EditProposal> {
  const picked = new Set(selected);
  const files = proposal.files.flatMap((file, fileIndex) => {
    const indexes = new Set(
      reviewHunksOfFile(file, fileIndex)
        .filter((hunk) => picked.has(hunk.hunkId))
        .flatMap((hunk) => hunk.replacementIndexes),
    );
    const replacements = file.replacements.filter((_replacement, index) => indexes.has(index));
    return replacements.length === 0 ? [] : [{ path: file.path, replacements }];
  });
  if (files.length === 0) throw new Error('选中的改动块没有对应任何替换。');

  const touched = new Set(files.map((file) => file.path));
  for (const file of proposal.files) {
    if (!touched.has(file.path)) continue;
    if ((await fs.sha256(await fs.read(file.path))) !== file.beforeHash) {
      throw new Error(`内容已漂移，审阅结果未应用：${file.path}`);
    }
  }
  const derived = await createEditProposal(files, fs);
  const original = new Map(proposal.files.map((file) => [file.path, file.beforeHash]));
  const drifted = derived.files.find((file) => original.get(file.path) !== file.beforeHash);
  if (drifted !== undefined) throw new Error(`内容已漂移，审阅结果未应用：${drifted.path}`);
  return derived;
}
