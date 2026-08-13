import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import type { EditProposalState, ToolContext } from '@xm/kernel';
import { createEditProposal, editApplyTool, type EditProposalAccess } from '@xm/tools-core';
import {
  MAX_RENDERED_DIFF_LINES,
  boundedDiff,
  latestPendingProposal,
} from '../src/renderer/lib/diff-review.js';
import { prepareReviewedProposal } from '../src/main/edit-review.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('diff review renderer', () => {
  it('单个大 hunk 的渲染模型最多保留 400 行', async () => {
    const { state } = await proposalFixture();
    const first = state.proposal.files[0]!;
    first.hunks![0]!.diff = Array.from({ length: 500 }, (_, index) => `line-${String(index)}`).join('\n');
    const view = boundedDiff(first.hunks![0]!.diff);
    expect(view.lines).toHaveLength(MAX_RENDERED_DIFF_LINES);
    expect(view.lines.at(-1)).toBe('line-399');
    expect(view.lines).not.toContain('line-400');
    expect(view.truncated).toBe(true);
  });

  it('pending 投影不把 applied/reviewed 提案重新显示', async () => {
    const { state } = await proposalFixture();
    expect(latestPendingProposal([state])).toBe(state);
    expect(latestPendingProposal([{ ...state, reviewedAt: 1 }])).toBeUndefined();
    expect(latestPendingProposal([{ ...state, appliedAt: 1 }])).toBeUndefined();
  });

  it('有界 diff helper 的阈值固定且可测试', () => {
    const view = boundedDiff(Array.from({ length: 401 }, () => 'x').join('\n'));
    expect(view.lines).toHaveLength(MAX_RENDERED_DIFF_LINES);
    expect(view.truncated).toBe(true);
  });
});

describe('diff review main workflow', () => {
  it('只选一个 hunk 时生成收窄提案；拒绝全部不生成提案', async () => {
    const { state, a, b } = await proposalFixture();
    const selected = state.proposal.files[0]!.hunks![0]!.hunkId;
    const derived = await prepareReviewedProposal(state, [selected]);
    expect(derived?.files).toHaveLength(1);
    expect(derived?.files[0]!.replacements).toHaveLength(1);
    expect(await prepareReviewedProposal(state, [])).toBeUndefined();

    let applied = false;
    const sessionId = newSessionId();
    const access: EditProposalAccess = {
      save: () => Promise.resolve(),
      get: () => Promise.resolve(derived === undefined ? undefined : { proposal: derived, applied }),
      markApplied: () => { applied = true; return Promise.resolve(); },
    };
    const tool = editApplyTool(access);
    const input = {
      proposalId: derived!.proposalId,
      files: derived!.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
    };
    for await (const progress of tool.execute(input, context(sessionId, join(a, '..')))) {
      // 消费完整工具流，落盘发生在最后一条 result 之前。
      void progress;
    }
    expect(applied).toBe(true);
    expect(await import('node:fs/promises').then((fs) => fs.readFile(a, 'utf8'))).toBe('A=新\nA2=旧\n');
    expect(await import('node:fs/promises').then((fs) => fs.readFile(b, 'utf8'))).toBe('B=旧\n');
  });

  it('审阅期间文件漂移时不生成派生提案', async () => {
    const { state, a } = await proposalFixture();
    await writeFile(a, '用户改过');
    const selected = state.proposal.files[0]!.hunks![0]!.hunkId;
    await expect(prepareReviewedProposal(state, [selected])).rejects.toThrow(/漂移/u);
  });
});

async function proposalFixture(): Promise<{ state: EditProposalState; a: string; b: string }> {
  const root = await mkdtemp(join(tmpdir(), 'xm-diff-review-'));
  roots.push(root);
  const a = join(root, 'a.txt');
  const b = join(root, 'b.txt');
  await writeFile(a, 'A=旧\nA2=旧\n');
  await writeFile(b, 'B=旧\n');
  const proposal = await createEditProposal([
    {
      path: a,
      replacements: [
        { oldText: 'A=旧', newText: 'A=新', expectedMatches: 1 },
        { oldText: 'A2=旧', newText: 'A2=新', expectedMatches: 1 },
      ],
    },
    { path: b, replacements: [{ oldText: 'B=旧', newText: 'B=新', expectedMatches: 1 }] },
  ]);
  return {
    a,
    b,
    state: { proposal, appliedAt: undefined, reviewedAt: undefined, selectedHunkIds: undefined },
  };
}

const context = (sessionId: ReturnType<typeof newSessionId>, cwd: string): ToolContext => ({
  sessionId,
  cwd,
  executor: 'local',
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
});
