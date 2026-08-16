import { z } from 'zod';
import type { EditProposal as Proposal, ToolProgress } from '@xm/contracts';
import type { ExecutionFileSystem, RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import {
  EDIT_APPLY,
  EDIT_PREVIEW,
  applyReplacements,
  assertUniquePaths,
  createEditProposal,
  decodeUtf8,
  type EditProposalAccess,
} from './edit-core.js';
import {
  EditPresentation,
  editPresentationOf,
  presentPreviewCall,
  presentPreviewResult,
  previewActions,
} from './edit-present.js';

export * from './edit-core.js';

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

/**
 * `edit.preview` 的规范输出值（ADR-0071）：**恰好是 `edit.apply` 需要的那些字段**。
 *
 * 这是整批迁移里最能说明问题的一个——`previewEnvelope()` 那段注释解释了为什么
 * `proposalId` + 每个文件的 `path`/`beforeHash` 必须逐行自足地排在散文最前面：
 * 因为下一步要靠模型从散文里把它们**认出来再抄一遍**。程序不需要认，也不会抄错。
 *
 * `diff` 不在这里：它是给人看的，程序要 diff 应当去读 `presentation`（已落库）
 * 或直接读文件。规范值只装"接着往下做需要什么"。
 */
const PreviewOutput = z.strictObject({
  proposalId: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      beforeHash: z.string(),
      afterHash: z.string(),
      replacements: z.number().int(),
      hunks: z.number().int(),
      /** 替换算下来内容没变——此时 diff 是空的 */
      unchanged: z.boolean(),
    }),
  ),
});

/** `edit.apply` 的规范输出值。三种 `kind` 都表示"盘上已是提案后的样子" */
const ApplyOutput = z.strictObject({
  proposalId: z.string(),
  kind: z.enum(['applied', 'already_applied', 'already_on_disk']),
  /** 本次真正写盘的文件；后两种 `kind` 是空数组 */
  written: z.array(z.string()),
});

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
    presentationSchema: EditPresentation,
    outputSchema: PreviewOutput,
    presentCall: presentPreviewCall,
    presentResult: presentPreviewResult,
    actions: previewActions(access),
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const proposal = await createEditProposal(input.files, ctx.executor.fs, ctx.signal);
      await access.save(ctx.sessionId, proposal);
      yield {
        kind: 'result',
        forModel: [{ type: 'text', text: previewEnvelope(proposal) }],
        presentation: editPresentationOf(proposal),
        output: {
          proposalId: proposal.proposalId,
          files: proposal.files.map((file) => ({
            path: file.path,
            beforeHash: file.beforeHash,
            afterHash: file.afterHash,
            replacements: file.replacements.length,
            hunks: file.hunks?.length ?? 1,
            unchanged: file.diff === '',
          })),
        },
      };
    },
  });

/**
 * 模型可见的预览结果（ADR-0050）。
 *
 * 以前这里是 `JSON.stringify(proposal)`——整份提案，含每个文件的完整 diff 和每条替换的
 * 逐份 diff 副本。它必然撞上统一结果截断（默认 64 KB、middle 策略），而被挖掉的正是中段：
 * 第二个文件之后的 `beforeHash` 全没了，`edit.apply` 因此永远拼不出合法入参。
 *
 * 现在的形状把**应用所必需的最小信息**（proposalId + 每个文件的 path/beforeHash）放在最前面
 * 且逐行自足，diff 放在后面。即使 diff 段被截断，apply 需要的东西也一定还在；被截掉的部分
 * 仍可通过 `result.expand` 按范围取回。完整提案照旧完整落 `edit.proposed` 事件供 UI 消费。
 */
function previewEnvelope(proposal: Proposal): string {
  const rows = proposal.files.map((file, index) => {
    const hunks = file.hunks?.length ?? 1;
    return (
      `${String(index + 1)}. ${file.path.replaceAll('\\', '/')}\n` +
      `   beforeHash=${file.beforeHash}\n` +
      `   afterHash=${file.afterHash}\n` +
      `   ${String(file.replacements.length)} 处替换，${String(hunks)} 个改动块`
    );
  });
  const diffs = proposal.files
    .map((file) => (file.diff === '' ? `（${file.path} 内容无变化）` : file.diff))
    .join('\n\n');
  return (
    `编辑提案 ${proposal.proposalId} 已生成，尚未写盘。\n` +
    `调用 edit.apply 时须原样传回该 proposalId，以及下面每一项的 path 与 beforeHash。\n\n` +
    `${rows.join('\n')}\n\n── diff ──\n${diffs}`
  );
}

export const editApplyTool = (
  access: EditProposalAccess,
  writeFile?: (path: string, content: string) => Promise<void>,
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
    outputSchema: ApplyOutput,
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const state = await access.get(ctx.sessionId, input.proposalId);
      if (state === undefined) throw new Error('找不到当前会话中的编辑提案。');
      if (state.applied) {
        yield result(`编辑提案 ${input.proposalId} 已应用，无需重复执行。`, {
          proposalId: input.proposalId,
          kind: 'already_applied',
          written: [],
        });
        return;
      }
      assertApplyInput(state.proposal, input.files);
      const prepared = await prepareApply(state.proposal, ctx.executor.fs);
      if (prepared === 'already-applied') {
        await access.markApplied(ctx.sessionId, input.proposalId);
        yield result(`编辑提案 ${input.proposalId} 已在磁盘生效，已补记完成事件。`, {
          proposalId: input.proposalId,
          kind: 'already_on_disk',
          written: [],
        });
        return;
      }

      for (const file of prepared) {
        if (ctx.signal.aborted) throw new Error('应用编辑提案前已取消，尚未写盘。');
        await (writeFile ?? ctx.executor.fs.writeTextAtomic)(file.path, file.content);
      }
      await access.markApplied(ctx.sessionId, input.proposalId);
      yield result(`已应用编辑提案 ${input.proposalId}：${String(prepared.length)} 个文件。`, {
        proposalId: input.proposalId,
        kind: 'applied',
        written: prepared.map((file) => file.path),
      });
    },
  });

async function prepareApply(
  proposal: Proposal,
  fs: ExecutionFileSystem,
): Promise<readonly { readonly path: string; readonly content: string }[] | 'already-applied'> {
  const current = await Promise.all(
    proposal.files.map(async (file) => {
      const bytes = await fs.read(file.path);
      return { file, bytes, hash: await fs.sha256(bytes), text: decodeUtf8(bytes, file.path) };
    }),
  );
  if (current.every((item) => item.hash === item.file.afterHash)) return 'already-applied';
  const drifted = current.filter((item) => item.hash !== item.file.beforeHash);
  if (drifted.length > 0) {
    throw new Error(`内容已漂移，零文件写入：${drifted.map((item) => item.file.path).join('、')}`);
  }
  return Promise.all(current.map(async ({ file, text }) => {
    const content = applyReplacements(text, file.replacements, file.path);
    if (await fs.sha256(Buffer.from(content, 'utf8')) !== file.afterHash) {
      throw new Error(`提案重算结果不一致，零文件写入：${file.path}`);
    }
    return { path: file.path, content };
  }));
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

const result = (text: string, output: z.infer<typeof ApplyOutput>): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text }],
  output,
});
