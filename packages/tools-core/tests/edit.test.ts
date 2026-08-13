import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionId, type EditProposal, type EditProposalId, type SessionId } from '@xm/contracts';
import type { ToolContext } from '@xm/kernel';
import {
  editApplyTool,
  editPreviewTool,
  nodeToolGateway,
  type EditProposalAccess,
} from '@xm/tools-core';

let root: string;
let access: MemoryAccess;
const sessionId = newSessionId();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xm-edit-'));
  access = new MemoryAccess();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('edit.preview', () => {
  it('精确替换 Unicode/CRLF，生成确定性 unified diff，且预览不写盘', async () => {
    const path = join(root, '你好.ts');
    const original = 'const 名称 = "旧";\r\nconst n = 1;\r\n';
    await writeFile(path, original);
    await execute(editPreviewTool(access), {
      files: [{
        path,
        replacements: [{ oldText: '"旧"', newText: '"新"', expectedMatches: 1 }],
      }],
    });

    expect(await readFile(path, 'utf8')).toBe(original);
    const proposal = access.only().proposal;
    expect(proposal.files[0]!.diff).toContain('--- a/');
    expect(proposal.files[0]!.diff).toContain('-const 名称 = "旧";\r');
    expect(proposal.files[0]!.diff).toContain('+const 名称 = "新";\r');
    expect(proposal.files[0]!.beforeHash).not.toBe(proposal.files[0]!.afterHash);
  });

  it.each([
    ['零命中', 'missing', 1],
    ['歧义命中', 'same', 1],
    ['期望次数不符', 'same', 3],
  ])('%s 时整体失败且不持久化提案', async (_label, oldText, expectedMatches) => {
    const path = join(root, 'a.txt');
    await writeFile(path, 'same same');
    await expect(execute(editPreviewTool(access), {
      files: [{ path, replacements: [{ oldText, newText: 'x', expectedMatches }] }],
    })).rejects.toThrow(/期望命中/u);
    expect(access.size).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('same same');
  });

  it('网关逐项规范化数组路径，并为每个文件生成读主张', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'b');
    const tool = editPreviewTool(access);
    const resolved = await nodeToolGateway().resolve(
      tool,
      tool.parseInput({
        files: [
          { path: 'a.txt', replacements: [{ oldText: 'a', newText: 'A' }] },
          { path: 'b.txt', replacements: [{ oldText: 'b', newText: 'B' }] },
        ],
      }),
      context(),
    );
    const a = join(root, 'a.txt').replaceAll('\\', '/');
    const b = join(root, 'b.txt').replaceAll('\\', '/');
    expect(resolved.claims).toEqual([
      { capability: 'fs.read', target: a },
      { capability: 'fs.read', target: b },
    ]);
    expect(resolved.input).toMatchObject({
      files: [{ path: a }, { path: b }],
    });
  });
});

describe('edit.apply', () => {
  it('一个提案应用多个文件，并只在成功后标记 applied', async () => {
    const [a, b] = await previewTwo();
    const proposal = access.only().proposal;
    await execute(editApplyTool(access), applyInput(proposal));
    expect(await readFile(a, 'utf8')).toBe('A=新\n');
    expect(await readFile(b, 'utf8')).toBe('B=新\n');
    expect(access.only().applied).toBe(true);
  });

  it('任一文件在预览后漂移时零文件写入', async () => {
    const [a, b] = await previewTwo();
    const proposal = access.only().proposal;
    await writeFile(b, '用户改过\n');
    await expect(execute(editApplyTool(access), applyInput(proposal))).rejects.toThrow(/漂移/u);
    expect(await readFile(a, 'utf8')).toBe('A=旧\n');
    expect(await readFile(b, 'utf8')).toBe('用户改过\n');
    expect(access.only().applied).toBe(false);
  });

  it('模型少报或篡改路径/哈希时在写盘前拒绝', async () => {
    const [a, b] = await previewTwo();
    const proposal = access.only().proposal;
    const forged = applyInput(proposal).files.slice(0, 1);
    await expect(execute(editApplyTool(access), { proposalId: proposal.proposalId, files: forged }))
      .rejects.toThrow(/不一致/u);
    expect(await readFile(a, 'utf8')).toBe('A=旧\n');
    expect(await readFile(b, 'utf8')).toBe('B=旧\n');
  });

  it('文件已全部是 afterHash 时幂等补记 applied，不重复写入', async () => {
    const [a, b] = await previewTwo();
    const proposal = access.only().proposal;
    await writeFile(a, 'A=新\n');
    await writeFile(b, 'B=新\n');
    let writes = 0;
    await execute(editApplyTool(access, () => { writes += 1; return Promise.resolve(); }), applyInput(proposal));
    expect(writes).toBe(0);
    expect(access.only().applied).toBe(true);
  });
});

async function previewTwo(): Promise<readonly [string, string]> {
  const a = join(root, 'a.txt');
  const b = join(root, 'b.txt');
  await writeFile(a, 'A=旧\n');
  await writeFile(b, 'B=旧\n');
  await execute(editPreviewTool(access), {
    files: [
      { path: a, replacements: [{ oldText: '旧', newText: '新', expectedMatches: 1 }] },
      { path: b, replacements: [{ oldText: '旧', newText: '新', expectedMatches: 1 }] },
    ],
  });
  return [a, b];
}

const applyInput = (proposal: EditProposal) => ({
  proposalId: proposal.proposalId,
  files: proposal.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
});

async function execute(tool: ReturnType<typeof editPreviewTool>, input: unknown): Promise<string> {
  const output: string[] = [];
  for await (const progress of tool.execute(input, context())) {
    if (progress.kind === 'result') {
      for (const block of progress.forModel) if (block.type === 'text') output.push(block.text);
    }
  }
  return output.join('\n');
}

const context = (): ToolContext => ({
  sessionId,
  cwd: root,
  executor: 'local',
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
});

class MemoryAccess implements EditProposalAccess {
  readonly #items = new Map<EditProposalId, { proposal: EditProposal; applied: boolean }>();
  get size(): number { return this.#items.size; }
  save(_sessionId: SessionId, proposal: EditProposal): Promise<void> {
    this.#items.set(proposal.proposalId, { proposal, applied: false });
    return Promise.resolve();
  }
  get(_sessionId: SessionId, proposalId: EditProposalId) {
    return Promise.resolve(this.#items.get(proposalId));
  }
  markApplied(_sessionId: SessionId, proposalId: EditProposalId): Promise<void> {
    const item = this.#items.get(proposalId);
    if (item !== undefined) item.applied = true;
    return Promise.resolve();
  }
  only(): { proposal: EditProposal; applied: boolean } {
    const item = [...this.#items.values()][0];
    if (item === undefined) throw new Error('没有提案');
    return item;
  }
}
