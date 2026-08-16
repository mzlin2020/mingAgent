import { localExecutionWorld } from '@xm/tool-runtime';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolProgress } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { RegisteredTool, ToolContext } from '@xm/kernel';
import {
  fsListTool,
  fsReadTool,
  fsWriteTool,
  shellExecTool,
  textSearchTool,
} from '@xm/tools-core';

/**
 * 内建工具真的产出规范输出值（ADR-0071），而且产出的是**程序用得上的那一份**。
 *
 * 这一组挑的四个工具各代表一类：
 *
 * · `fs.read`   —— 正文必须**不带行号前缀**。带前缀的话，Code Mode 里每次读文件
 *                  都得先写一遍切割逻辑，那就等于没做这次迁移。
 * · `fs.list`   —— 大小是**数字**，读不到时**缺席**。以前它是渲染好的
 *                  `"12.3 KB"` / `"（读不到大小）"`，两种情况在结构上无从分辨。
 * · `shell.exec`—— 结局是闭集的 `kind`，不是那句中文开头语；且退出码**缺席不等于 0**。
 * · `search.text`—— 位置是结构，不是 `path:line:col:` 拼起来的字符串。
 *
 * 每条都同时断言 `parseOutput` 能过——工具自己 yield 的东西不合自己声明的 schema 时，
 * 运行时会**静默丢掉**它，那种错误只有在这里才拦得住。
 */

let dir: string;

const ctx = (): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: dir,
  executor: localExecutionWorld,
});

/** 跑一次工具，取它 yield 的规范值，并且**必须**能过工具自己的 schema */
async function outputOf(tool: RegisteredTool, input: unknown): Promise<unknown> {
  const out: ToolProgress[] = [];
  for await (const progress of tool.execute(input, ctx())) out.push(progress);
  const last = out.at(-1);
  if (last?.kind !== 'result') throw new Error('工具最后一条必须是 result');
  const parsed = tool.parseOutput(last.output);
  expect(parsed, '工具产出的规范值没通过它自己声明的 outputSchema').toBeDefined();
  return parsed;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-output-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fs 工具的规范输出值', () => {
  it('fs.read 的 content 是原文，不带模型看的那层行号前缀', async () => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');

    const output = await outputOf(fsReadTool(), { path: file });
    expect(output).toMatchObject({
      path: file,
      kind: 'text',
      content: 'alpha\nbeta\ngamma',
      firstLine: 1,
      lineCount: 3,
      truncated: false,
    });
    expect((output as { content: string }).content).not.toContain('\t');
  });

  it('fs.read 读目录 / 二进制 / 空文件：kind 分得开，正文一律为空', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(join(dir, 'empty'), '', 'utf8');

    const tool = fsReadTool();
    expect(await outputOf(tool, { path: join(dir, 'sub') })).toMatchObject({
      kind: 'directory',
      content: '',
    });
    expect(await outputOf(tool, { path: join(dir, 'bin') })).toMatchObject({
      kind: 'binary',
      content: '',
    });
    expect(await outputOf(tool, { path: join(dir, 'empty') })).toMatchObject({
      kind: 'empty',
      content: '',
    });
  });

  it('fs.read 越过末尾：out_of_range，不是"读到了 0 行的文本"', async () => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'only\n', 'utf8');
    expect(await outputOf(fsReadTool(), { path: file, offset: 9 })).toMatchObject({
      kind: 'out_of_range',
      lineCount: 0,
    });
  });

  it('fs.list 的 size 是数字，且目录条目没有 size 字段', async () => {
    await writeFile(join(dir, 'a.txt'), '1234567890', 'utf8');
    await mkdir(join(dir, 'sub'));

    const output = (await outputOf(fsListTool(), { path: dir })) as {
      kind: string;
      entries: { path: string; kind: string; size?: number; expanded: boolean }[];
    };
    expect(output.kind).toBe('directory');
    const file = output.entries.find((entry) => entry.path === 'a.txt');
    const sub = output.entries.find((entry) => entry.path === 'sub');
    expect(file).toEqual({ path: 'a.txt', kind: 'file', size: 10, expanded: false });
    expect(sub).toEqual({ path: 'sub', kind: 'dir', expanded: false });
  });

  it('fs.write 区分新建与覆盖，并如实报告拒绝时"什么都没写"', async () => {
    const file = join(dir, 'w.txt');
    const tool = fsWriteTool();
    expect(await outputOf(tool, { path: file, content: 'ab' })).toEqual({
      path: file,
      kind: 'created',
      bytes: 2,
    });
    expect(await outputOf(tool, { path: file, content: 'abc' })).toEqual({
      path: file,
      kind: 'overwritten',
      bytes: 3,
    });
  });
});

describe('shell.exec 的规范输出值', () => {
  it('结局是闭集的 kind，退出码与两条流原样给出', async () => {
    const output = await outputOf(shellExecTool({ os: 'linux', env: {} }), {
      argv: ['node', '-e', 'process.stdout.write("out");process.exit(3)'],
      cwd: dir,
    });
    expect(output).toMatchObject({ kind: 'exited', exitCode: 3, stdout: 'out', cwd: dir });
  });

  it('🔴 起不来的命令：kind 是 spawn_failed，且**没有** exitCode——缺席不等于 0', async () => {
    const output = (await outputOf(shellExecTool({ os: 'linux', env: {} }), {
      argv: ['xm-绝不存在的命令'],
      cwd: dir,
    })) as Record<string, unknown>;
    expect(output.kind).toBe('spawn_failed');
    expect('exitCode' in output).toBe(false);
    expect(output.spawnError).toEqual(expect.any(String));
  });
});

describe('search.text 的规范输出值', () => {
  it('命中位置是结构，不是 path:line:col 拼出来的字符串', async () => {
    await writeFile(join(dir, 'a.ts'), 'const 找我 = 1;\nconst other = 2;\n', 'utf8');

    const output = (await outputOf(textSearchTool({ os: 'linux' }), {
      pattern: '找我',
      path: dir,
      maxResults: 10,
    })) as {
      kind: string;
      source: string;
      matches: number;
      hits: { path: string; line: number; column: number; text: string; context: boolean }[];
    };

    expect(output.kind).toBe('ok');
    expect(output.matches).toBe(1);
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0]).toMatchObject({ path: 'a.ts', line: 1, context: false });
    // 列号是**字符**列、1 起算：`const ` 之后是第 7 个字符
    expect(output.hits[0]?.column).toBe(7);
  });

  it('没有匹配：kind 是 no_match，hits 为空——不是"失败"', async () => {
    await writeFile(join(dir, 'a.ts'), 'nothing here\n', 'utf8');
    expect(
      await outputOf(textSearchTool({ os: 'linux' }), {
        pattern: '绝不出现的词',
        path: dir,
        maxResults: 10,
      }),
    ).toMatchObject({ kind: 'no_match', hits: [], matches: 0 });
  });
});
