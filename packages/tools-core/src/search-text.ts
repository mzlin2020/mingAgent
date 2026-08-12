import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { AbortLike, RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

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
  /** 可用于平台打包路径，也让“ripgrep 缺失”有确定性测试入口。 */
  readonly executable?: string;
}

export const textSearchTool = (options: TextSearchOptions = {}): RegisteredTool =>
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

      if (outcome.spawnError !== undefined) {
        yield result(
          `ripgrep 不可用，无法启动 ${options.executable ?? 'rg'}：${outcome.spawnError}。` +
            '请确认当前平台已安装 ripgrep，或配置可执行文件路径。',
        );
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

interface RunInput {
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

function runRipgrep(input: RunInput): Promise<RunOutcome> {
  return new Promise<RunOutcome>((done) => {
    const args = ['--json', '--max-columns', String(MAX_COLUMNS)];
    if (input.caseSensitive === true) args.push('--case-sensitive');
    else if (input.caseSensitive === false) args.push('--ignore-case');
    else args.push('--smart-case');
    if (input.context > 0) args.push('--context', String(input.context));
    for (const glob of input.globs) args.push('--glob', glob);
    args.push('--', input.pattern, input.path);

    const child = spawn(input.executable, args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const lines: string[] = [];
    let pending = '';
    let stderr = '';
    let matches = 0;
    let limited = false;
    let interrupted = false;
    let parseError: string | undefined;
    let spawnError: string | undefined;
    let settled = false;

    const stop = (): void => {
      if (!child.killed) child.kill();
    };
    const onAbort = (): void => {
      interrupted = true;
      stop();
    };
    input.signal.addEventListener('abort', onAbort);

    const consume = (line: string): void => {
      if (line === '' || parseError !== undefined) return;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line) as RgJsonEvent;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
        stop();
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') return;
      const data = event.data;
      if (data === undefined) return;
      const path = data.path?.text;
      const text = data.lines?.text;
      const lineNumber = data.line_number;
      if (path === undefined || text === undefined || lineNumber === undefined) return;

      if (event.type === 'match') {
        matches += 1;
        if (matches > input.maxResults) {
          matches = input.maxResults;
          limited = true;
          stop();
          return;
        }
      }
      const start = event.type === 'match' ? (data.submatches?.[0]?.start ?? 0) : -1;
      const column = start < 0 ? 0 : unicodeColumn(text, start);
      lines.push(
        `${displayPath(input.cwd, path)}:${String(lineNumber)}:${String(column)}: ${oneLine(text)}`,
      );
    };

    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    });
    child.on('error', (error: Error) => {
      spawnError = error.message;
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      consume(pending);
      done({
        lines,
        matches,
        limited,
        interrupted,
        code: code ?? undefined,
        stderr: stderr.trim(),
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(parseError === undefined ? {} : { parseError }),
      });
    });
  });
}

function unicodeColumn(line: string, byteOffset: number): number {
  const prefix = Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8');
  return Array.from(prefix).length + 1;
}

function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path);
  return (shown === '' || shown.startsWith('..') ? path : shown).replaceAll('\\', '/');
}

const oneLine = (text: string): string => text.replace(/\r?\n/g, '↵').replace(/↵$/, '');
const result = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text }],
});
