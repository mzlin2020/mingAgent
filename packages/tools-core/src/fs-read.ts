import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const FS_READ = 'fs.read';

/**
 * 读一个文本文件。
 *
 * ── 为什么按行流式读，而不是 readFile 之后交给截断 ──
 *
 * 运行时的 `truncateResult` 会把超长结果截掉，所以"先整份读进来"看起来无所谓。
 * 但那意味着模型随口给一个 4 GB 的日志路径，就能让主进程当场吃满内存——
 * 截断发生在**已经付过代价之后**。这里读满上限就停，代价与结果大小同阶。
 *
 * ── 行号是给模型用的 ──
 *
 * 输出带行号前缀，因为模型接下来要做的事十有八九需要引用位置（"第 42 行那个函数"），
 * 而它自己数行会数错。这也让 `offset` / `limit` 变成一个它能自己用起来的接口：
 * 截断标记里指的正是这两个参数。
 */
const Input = z.strictObject({
  path: z.string().min(1).describe('要读取的文件路径，可以是相对当前工作目录的'),
  offset: z.number().int().positive().optional().describe('从第几行开始读，1 起算。默认第一行'),
  limit: z.number().int().positive().optional().describe('最多读多少行。默认读到大小上限为止'),
});

/**
 * 规范输出值（ADR-0071）。
 *
 * `content` 是**不带行号前缀**的原文——`forModel` 里那份带行号是给模型数行用的，
 * 程序拿到它只会先把前缀切掉，那正是"程序去解析散文"要避免的事。
 */
const Output = z.strictObject({
  path: z.string(),
  /** `text` 之外都表示没有读出正文，`content` 为空串 */
  kind: z.enum(['text', 'directory', 'binary', 'empty', 'out_of_range']),
  content: z.string(),
  /** 本次返回的第一行行号，1 起算 */
  firstLine: z.number().int(),
  lineCount: z.number().int(),
  /** 读到字节上限提前停下；接着读要用 firstLine + lineCount */
  truncated: z.boolean(),
  /** 文件总字节数 */
  size: z.number().int(),
});

/** 读取的字节硬上限。比默认结果上限（64 KB）宽一些，让截断标记有东西可截 */
const MAX_BYTES = 512 * 1024;
/** 一行的长度上限。极长的单行（压缩后的 JS、base64）会让行号毫无意义，就地截掉 */
const MAX_LINE = 2000;

export const fsReadTool = (): RegisteredTool =>
  defineTool({
    name: FS_READ,
    group: 'fs',
    description:
      '读取一个文本文件的内容，返回带行号的文本。可用 offset / limit 按行范围读取大文件。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    outputSchema: Output,

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const info = await ctx.executor.fs.stat(input.path);
      const base = { path: input.path, content: '', firstLine: 0, lineCount: 0, truncated: false };
      if (info.directory) {
        yield text(`${input.path} 是一个目录，不是文件。用 fs.list 列出它的内容。`, {
          ...base,
          kind: 'directory',
          size: info.size,
        });
        return;
      }

      const from = input.offset ?? 1;
      const upto = input.limit === undefined ? Infinity : from + input.limit - 1;

      const outcome = await readLines(ctx.executor.fs, input.path, from, upto, ctx.signal.aborted);
      if (outcome.binary) {
        yield text(
          `${input.path} 看起来是二进制文件（前几千字节里有空字节），` +
            `共 ${String(info.size)} 字节。没有按文本读出来——` +
            `乱码进上下文既占预算又会误导判断。`,
          { ...base, kind: 'binary', size: info.size },
        );
        return;
      }

      if (outcome.lines.length === 0) {
        yield text(
          info.size === 0
            ? `${input.path} 是空文件。`
            : `${input.path} 共 ${String(outcome.scanned)} 行，第 ${String(from)} 行之后没有内容。`,
          { ...base, kind: info.size === 0 ? 'empty' : 'out_of_range', size: info.size },
        );
        return;
      }

      const body = outcome.lines.map((l, i) => `${String(from + i)}\t${l}`).join('\n');
      const note = outcome.stoppedEarly
        ? `\n[... 已读到 ${String(MAX_BYTES / 1024)} KB 上限，用 offset=${String(from + outcome.lines.length)} 继续 ...]`
        : '';
      yield text(body + note, {
        path: input.path,
        kind: 'text',
        content: outcome.lines.join('\n'),
        firstLine: from,
        lineCount: outcome.lines.length,
        truncated: outcome.stoppedEarly,
        size: info.size,
      });
    },
  });

interface ReadOutcome {
  readonly lines: readonly string[];
  readonly scanned: number;
  readonly binary: boolean;
  readonly stoppedEarly: boolean;
}

async function readLines(
  fs: import('@xm/kernel').ExecutionFileSystem,
  path: string,
  from: number,
  upto: number,
  alreadyAborted: boolean,
): Promise<ReadOutcome> {
  if (alreadyAborted) return { lines: [], scanned: 0, binary: false, stoppedEarly: false };

  const lines: string[] = [];
  let scanned = 0;
  let bytes = 0;
  let pending = '';
  let binary = false;
  let stoppedEarly = false;

  const decoder = new TextDecoder('utf-8');

  for await (const chunk of fs.readChunks(path, 64 * 1024)) {
    const piece = decoder.decode(chunk, { stream: true });
    // 空字节是二进制最可靠的信号。只看开头几块——整份扫一遍等于把文件读完，
    // 而"读完才发现不该读"正是这个函数要避免的事
    if (bytes < 8192 && piece.includes('\0')) {
      binary = true;
      break;
    }

    bytes += Buffer.byteLength(piece, 'utf8');
    pending += piece;

    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      scanned += 1;
      if (scanned >= from && scanned <= upto) lines.push(clip(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }

    if (bytes >= MAX_BYTES) {
      stoppedEarly = true;
      break;
    }
  }
  pending += decoder.decode();

  if (!binary && pending !== '') {
    scanned += 1;
    if (scanned >= from && scanned <= upto) lines.push(clip(pending));
  }

  return { lines, scanned, binary, stoppedEarly };
}

const clip = (line: string): string => {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  return trimmed.length <= MAX_LINE
    ? trimmed
    : `${trimmed.slice(0, MAX_LINE)} […本行还有 ${String(trimmed.length - MAX_LINE)} 个字符]`;
};

const text = (s: string, output: z.infer<typeof Output>): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text: s }],
  output,
});
