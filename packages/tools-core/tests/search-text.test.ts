import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultBlock, ToolProgress } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { RegisteredTool, ToolContext } from '@xm/kernel';
import { textSearchTool } from '@xm/tools-core';

let dir: string;

const ctx = (aborted = false): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: dir,
  executor: 'local',
});

async function run(tool: RegisteredTool, input: unknown, context = ctx()): Promise<string> {
  const progress: ToolProgress[] = [];
  for await (const item of tool.execute(input, context)) progress.push(item);
  const last = progress.at(-1);
  if (last?.kind !== 'result') throw new Error('工具最后一条必须是 result');
  return textOf(last.forModel);
}

const textOf = (blocks: readonly ResultBlock[]): string =>
  blocks.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-search-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('search.text', () => {
  it('返回稳定位置，Unicode 列号按字符而不是 UTF-8 字节计算', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'alpha\n你好 needle\nomega\n');

    const out = await run(textSearchTool(), { pattern: 'needle', path: dir });

    expect(out).toContain('src/a.ts:2:4: 你好 needle');
    expect(out).toMatch(/ignore 规则/);
    expect(out).toMatch(/二进制文件/);
  });

  it('支持 glob、大小写与上下文行；上下文的 column 明确为 0', async () => {
    await writeFile(join(dir, 'a.ts'), 'before\nNeedle\nafter\n');
    await writeFile(join(dir, 'a.md'), 'Needle\n');

    const out = await run(textSearchTool(), {
      pattern: 'needle',
      path: dir,
      glob: ['*.ts'],
      caseSensitive: false,
      context: 1,
    });

    expect(out).toContain('a.ts:1:0: before');
    expect(out).toContain('a.ts:2:1: Needle');
    expect(out).toContain('a.ts:3:0: after');
    expect(out).not.toContain('a.md');
  });

  it('忽略文件和二进制文件不混入结果', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(dir, 'visible.txt'), 'needle\n');
    await writeFile(join(dir, 'ignored.txt'), 'needle\n');
    await writeFile(join(dir, 'binary.bin'), Buffer.from('needle\0tail'));

    const out = await run(textSearchTool(), { pattern: 'needle', path: dir });

    expect(out).toContain('visible.txt:1:1');
    expect(out).not.toContain('ignored.txt:1:1');
    expect(out).not.toContain('binary.bin:1:1');
  });

  it('空结果、全局上限和中断分别显式说明', async () => {
    await writeFile(join(dir, 'many.txt'), 'needle\nneedle\nneedle\n');

    expect(await run(textSearchTool(), { pattern: 'absent', path: dir })).toMatch(/没有匹配/);
    expect(
      await run(textSearchTool(), { pattern: 'needle', path: dir, maxResults: 2 }),
    ).toMatch(/已达 2 条上限.*可能还有更多/);
    expect(await run(textSearchTool(), { pattern: 'needle', path: dir }, ctx(true))).toMatch(
      /已中断/,
    );
  });

  it('ripgrep 不可用时不伪装成无匹配', async () => {
    const out = await run(
      textSearchTool({ executable: 'xm-ripgrep-definitely-missing' }),
      { pattern: 'needle', path: dir },
    );
    expect(out).toMatch(/ripgrep.*不可用/);
    expect(out).not.toMatch(/没有匹配/);
  });
});
