import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultBlock, ToolProgress } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { RegisteredTool, ToolContext } from '@xm/kernel';
import { textSearchTool } from '@xm/tools-core';

let dir: string;

/*
 * 宿主有没有 ripgrep 是**环境事实**，不是产品行为（ADR-0051）。
 *
 * 这里原来假定 rg 一定在：本机没装时会红 4 个用例，而 CI 里一句 `choco install ripgrep`
 * 把这件事盖住了。现在两条路径分开测——rg 那条按可用性跳过，Node 退路那条恒定跑，
 * 因为它才是普通用户开箱即得的那条。
 */
const hasRipgrep = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
/** 强制走退路：给一个一定启动不了的可执行名 */
const missingRg = { executable: 'xm-ripgrep-definitely-missing' };

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

/** 两条实现路径都必须满足的同一份输出契约。 */
function sharedContract(label: string, make: () => RegisteredTool): void {
  describe(`search.text · ${label}`, () => {
    it('返回稳定位置，Unicode 列号按字符而不是 UTF-8 字节计算', async () => {
      await mkdir(join(dir, 'src'));
      await writeFile(join(dir, 'src', 'a.ts'), 'alpha\n你好 needle\nomega\n');

      expect(await run(make(), { pattern: 'needle', path: dir })).toContain(
        'src/a.ts:2:4: 你好 needle',
      );
    });

    it('支持 glob、大小写与上下文行；上下文的 column 明确为 0', async () => {
      await writeFile(join(dir, 'a.ts'), 'before\nNeedle\nafter\n');
      await writeFile(join(dir, 'a.md'), 'Needle\n');

      const out = await run(make(), {
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

    it('二进制文件不混入结果', async () => {
      await writeFile(join(dir, 'visible.txt'), 'needle\n');
      await writeFile(join(dir, 'binary.bin'), Buffer.from('needle\0tail'));

      const out = await run(make(), { pattern: 'needle', path: dir });

      expect(out).toContain('visible.txt:1:1');
      expect(out).not.toContain('binary.bin:1:1');
    });

    it('空结果、全局上限和中断分别显式说明', async () => {
      await writeFile(join(dir, 'many.txt'), 'needle\nneedle\nneedle\n');

      expect(await run(make(), { pattern: 'absent', path: dir })).toMatch(/没有匹配/u);
      expect(await run(make(), { pattern: 'needle', path: dir, maxResults: 2 })).toMatch(
        /已达 2 条上限.*可能还有更多/u,
      );
      expect(await run(make(), { pattern: 'needle', path: dir }, ctx(true))).toMatch(/已中断/u);
    });

    it('smart-case：模式全小写时不区分大小写，含大写时区分', async () => {
      await writeFile(join(dir, 'a.txt'), 'Needle\nneedle\n');

      expect(await run(make(), { pattern: 'needle', path: dir })).toMatch(/找到 2 条/u);
      expect(await run(make(), { pattern: 'Needle', path: dir })).toMatch(/找到 1 条/u);
    });
  });
}

sharedContract('Node 退路（无 ripgrep）', () => textSearchTool(missingRg));
if (hasRipgrep) sharedContract('ripgrep', () => textSearchTool());

describe('search.text · 两条路径的差异如实声明', () => {
  it('Node 退路标明 source 与忽略规则差异，不伪装成 ripgrep', async () => {
    await writeFile(join(dir, 'a.txt'), 'needle\n');
    const out = await run(textSearchTool(missingRg), { pattern: 'needle', path: dir });

    expect(out).toContain('source: node-fallback');
    expect(out).toMatch(/不读 \.gitignore/u);
    expect(out).not.toMatch(/没有匹配/u);
  });

  it('Node 退路对非法正则显式报错，不当作零结果', async () => {
    const out = await run(textSearchTool(missingRg), { pattern: '([unclosed', path: dir });

    expect(out).toMatch(/正则表达式无法解析/u);
    expect(out).not.toMatch(/没有匹配/u);
  });

  it.runIf(hasRipgrep)('只有 ripgrep 那条路径遵守 .gitignore', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(dir, 'visible.txt'), 'needle\n');
    await writeFile(join(dir, 'ignored.txt'), 'needle\n');

    const out = await run(textSearchTool(), { pattern: 'needle', path: dir });

    expect(out).toContain('visible.txt:1:1');
    expect(out).not.toContain('ignored.txt:1:1');
    expect(out).toMatch(/ignore 规则/u);
  });
});
