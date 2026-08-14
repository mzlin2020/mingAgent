import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { AbortLike, ExecutionFileSystem, ExecutionProcess, OsFamily, RegisteredTool, ToolContext } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { nodeTextSearch } from './search-fallback.js';

export const SEARCH_TEXT = 'search.text';

const Input = z.strictObject({
  pattern: z.string().min(1).max(10_000).describe('ripgrep 正则表达式'),
  path: z.string().min(1).default('.').describe('搜索文件或目录，默认当前工作目录'),
  glob: z.array(z.string().min(1)).max(20).optional().describe('限定文件 glob，可给多个'),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('true 区分大小写，false 不区分；省略时使用 smart-case'),
  context: z.number().int().min(0).max(20).optional().describe('每条匹配前后附带的上下文行数'),
  maxResults: z.number().int().min(1).max(1000).default(100).describe('全局匹配条数上限'),
});

const MAX_COLUMNS = 4000;
const MAX_STDERR = 16 * 1024;

export interface TextSearchOptions {
  readonly os: OsFamily;
  /** 可用于平台打包路径，也让“ripgrep 缺失”有确定性测试入口。 */
  readonly executable?: string;
}

export const textSearchTool = (options: TextSearchOptions): RegisteredTool =>
  defineTool({
    name: SEARCH_TEXT,
    group: 'search',
    description:
      '用 ripgrep 搜索文本，返回稳定的 path:line:column 位置。支持 glob、大小写、上下文与全局结果上限。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (ctx.signal.aborted) {
        yield result('搜索已中断，没有启动 ripgrep。');
        return;
      }

      const outcome = await runRipgrep({
        process: ctx.executor.process,
        fs: ctx.executor.fs,
        os: options.os,
        executable: options.executable ?? 'rg',
        pattern: input.pattern,
        path: input.path,
        cwd: ctx.cwd,
        globs: input.glob ?? [],
        caseSensitive: input.caseSensitive,
        context: input.context ?? 0,
        maxResults: input.maxResults,
        signal: ctx.signal,
      });

      /*
       * ripgrep 缺失不再是"搜索不可用"（ADR-0051）。
       *
       * M2-b 原来在这里直接报"请安装 ripgrep"。报错是显式的，但普通 Windows / macOS
       * 用户机器上根本没有 rg，于是整条检索能力开箱即废——而 search.symbol /
       * search.indexed 的退路也指向这里，一起哑掉。改为退到纯 Node 实现，
       * 并在结果里标明 source 与忽略规则差异，而不是假装两条路径完全等价。
       */
      if (outcome.spawnError !== undefined) {
        yield* nodeFallbackResult(input, ctx, options, outcome.spawnError);
        return;
      }
      if (outcome.interrupted) {
        yield result('搜索已中断，ripgrep 进程已经结束。');
        return;
      }
      if (outcome.parseError !== undefined) {
        yield result(`ripgrep 返回了无法解析的 JSON：${outcome.parseError}`);
        return;
      }
      if (outcome.code !== 0 && outcome.code !== 1 && !outcome.limited) {
        const detail = outcome.stderr === '' ? '没有错误详情。' : outcome.stderr;
        yield result(`ripgrep 搜索失败（退出码 ${String(outcome.code ?? -1)}）：${detail}`);
        return;
      }

      const notes =
        '[搜索遵守 .gitignore/.ignore 等 ignore 规则；二进制文件默认跳过；' +
        `超过 ${String(MAX_COLUMNS)} 字节的单行由 ripgrep 跳过。]`;
      if (outcome.matches === 0) {
        yield result(`没有匹配。\n${notes}`);
        return;
      }

      const limitNote = outcome.limited
        ? `\n[已达 ${String(input.maxResults)} 条上限，可能还有更多匹配；请缩小 path/glob/pattern。]`
        : '';
      yield result(
        `找到 ${String(outcome.matches)} 条匹配。\n${outcome.lines.join('\n')}${limitNote}\n${notes}`,
      );
    },
  });

async function* nodeFallbackResult(
  input: z.infer<typeof Input>,
  ctx: ToolContext,
  options: TextSearchOptions,
  spawnError: string,
): AsyncIterable<ToolProgress> {
  const outcome = await nodeTextSearch({
    pattern: input.pattern,
    path: input.path,
    cwd: ctx.cwd,
    globs: input.glob ?? [],
    caseSensitive: input.caseSensitive,
    context: input.context ?? 0,
    maxResults: input.maxResults,
    signal: ctx.signal,
  }, ctx.executor.fs);

  const banner =
    `[source: node-fallback；未能启动 ${options.executable ?? 'rg'}：${spawnError}。` +
    '退路不读 .gitignore，只跳过隐藏项与 node_modules/dist/build/out/coverage/release/' +
    'target/vendor/__pycache__；不跟随符号链接；正则按 JavaScript 语法解析。' +
    '安装 ripgrep 可获得完整忽略规则与更好性能。]';

  if (outcome.patternError !== undefined) {
    yield result(`${banner}\n正则表达式无法解析：${outcome.patternError}`);
    return;
  }
  if (outcome.interrupted) {
    yield result(`${banner}\n搜索已中断。`);
    return;
  }
  if (outcome.matches === 0) {
    yield result(`${banner}\n没有匹配。`);
    return;
  }
  const limitNote = outcome.limited
    ? `\n[已达 ${String(input.maxResults)} 条上限，可能还有更多匹配；请缩小 path/glob/pattern。]`
    : '';
  yield result(
    `找到 ${String(outcome.matches)} 条匹配。\n${outcome.lines.join('\n')}${limitNote}\n${banner}`,
  );
}

interface RunInput {
  readonly process: ExecutionProcess;
  readonly fs: ExecutionFileSystem;
  readonly os: OsFamily;
  readonly executable: string;
  readonly pattern: string;
  readonly path: string;
  readonly cwd: string;
  readonly globs: readonly string[];
  readonly caseSensitive: boolean | undefined;
  readonly context: number;
  readonly maxResults: number;
  readonly signal: AbortLike;
}

interface RunOutcome {
  readonly lines: readonly string[];
  readonly matches: number;
  readonly limited: boolean;
  readonly interrupted: boolean;
  readonly code: number | undefined;
  readonly stderr: string;
  readonly spawnError?: string;
  readonly parseError?: string;
}

interface RgJsonData {
  readonly path?: { readonly text?: string };
  readonly lines?: { readonly text?: string };
  readonly line_number?: number;
  readonly submatches?: readonly { readonly start?: number }[];
}

interface RgJsonEvent {
  readonly type?: string;
  readonly data?: RgJsonData;
}

async function runRipgrep(input: RunInput): Promise<RunOutcome> {
    const args = ['--json', '--max-columns', String(MAX_COLUMNS)];
    if (input.caseSensitive === true) args.push('--case-sensitive');
    else if (input.caseSensitive === false) args.push('--ignore-case');
    else args.push('--smart-case');
    if (input.context > 0) args.push('--context', String(input.context));
    for (const glob of input.globs) args.push('--glob', glob);
    args.push('--', input.pattern, input.path);

    const lines: string[] = [];
    let pending = '';
    let stderr = '';
    let matches = 0;
    let limited = false;
    let parseError: string | undefined;

    const consume = (line: string): boolean => {
      if (line === '' || parseError !== undefined) return parseError === undefined;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line) as RgJsonEvent;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
        return false;
      }
      if (event.type !== 'match' && event.type !== 'context') return true;
      const data = event.data;
      if (data === undefined) return true;
      const path = data.path?.text;
      const text = data.lines?.text;
      const lineNumber = data.line_number;
      if (path === undefined || text === undefined || lineNumber === undefined) return true;

      if (event.type === 'match') {
        matches += 1;
        if (matches > input.maxResults) {
          matches = input.maxResults;
          limited = true;
          return false;
        }
      }
      const start = event.type === 'match' ? (data.submatches?.[0]?.start ?? 0) : -1;
      const column = start < 0 ? 0 : unicodeColumn(text, start);
      lines.push(
        `${displayPath(input.fs, input.cwd, path)}:${String(lineNumber)}:${String(column)}: ${oneLine(text)}`,
      );
      return true;
    };

    const onStdout = (chunk: string): boolean => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        if (!consume(pending.slice(0, newline))) return false;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      return true;
    };
    const onStderr = (chunk: string): void => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    };
    const run = await input.process.run({
      argv: [input.executable, ...args],
      cwd: input.cwd,
      timeoutMs: 120_000,
      signal: input.signal,
      os: input.os,
      maxOutputBytes: 16 * 1024 * 1024,
      onStdout,
      onStderr,
    });
    if (pending !== '' && parseError === undefined && !run.stoppedByConsumer) consume(pending);
    return {
      lines,
      matches,
      limited,
      interrupted: run.interrupted,
      code: run.code,
      stderr: stderr.trim(),
      ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
      ...(parseError === undefined ? {} : { parseError }),
    };
}

function unicodeColumn(line: string, byteOffset: number): number {
  const prefix = Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8');
  return Array.from(prefix).length + 1;
}

function displayPath(fs: ExecutionFileSystem, cwd: string, path: string): string {
  const shown = fs.path.relative(cwd, path);
  return (shown === '' || shown.startsWith('..') ? path : shown).replaceAll('\\', '/');
}

const oneLine = (text: string): string => text.replace(/\r?\n/g, '↵').replace(/↵$/, '');
const result = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text }],
});
