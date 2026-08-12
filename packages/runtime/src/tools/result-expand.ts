import { z } from 'zod';
import type { BlobRef, SessionId, ToolProgress } from '@xm/contracts';
import type { AbortLike, BlobStore, RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const RESULT_EXPAND = 'result.expand';

const LOCATOR = /^blob:sha256:([a-f0-9]{64})$/;
const DEFAULT_LINES = 50;
const MAX_LINES = 50;
const MAX_LINE_CHARS = 1000;

const Input = z.strictObject({
  ref: z
    .string()
    .regex(LOCATOR)
    .describe('截断标记给出的完整 blob:sha256:<64 位 hash> 定位符'),
  offset: z.number().int().positive().default(1).describe('从第几行开始，1 起算'),
  limit: z.number().int().min(1).max(MAX_LINES).default(DEFAULT_LINES).describe('最多读取多少行'),
});

export interface ResultRefQuery {
  readonly sessionId: SessionId;
  readonly hash: string;
}

export interface ResultExpandOptions {
  readonly blobs: BlobStore;
  /** 只返回当前会话持久化 tool.end.fullRef 可达的引用。 */
  readonly resolveRef: (query: ResultRefQuery) => Promise<BlobRef | undefined>;
}

export const resultExpandTool = (options: ResultExpandOptions): RegisteredTool =>
  defineTool({
    name: RESULT_EXPAND,
    group: 'result',
    description:
      '按行范围展开当前会话中被截断的完整工具结果。ref 必须来自截断标记；offset 从 1 开始。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: [],
    concurrency: 'parallel',
    resultLimits: { maxBytes: 256 * 1024, maxLines: 60, strategy: 'head' },
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const hash = LOCATOR.exec(input.ref)?.[1];
      if (hash === undefined) {
        yield result('完整结果引用格式不正确。');
        return;
      }

      try {
        const ref = await options.resolveRef({ sessionId: ctx.sessionId, hash });
        if (ref === undefined) {
          yield result('这个完整结果引用不属于当前会话，或对应的工具结果尚未持久化。');
          return;
        }
        const expanded = await readRange(options.blobs, ref, input.offset, input.limit, ctx.signal);
        if (expanded.interrupted) {
          yield result('结果展开已中断。');
          return;
        }
        if (expanded.lines.length === 0) {
          yield result(
            expanded.total === 0
              ? '完整工具结果是空文本。'
              : `完整工具结果共 ${String(expanded.total)} 行，第 ${String(input.offset)} 行之后没有内容。`,
          );
          return;
        }
        const end = input.offset + expanded.lines.length - 1;
        yield result(
          `${input.ref} 第 ${String(input.offset)}-${String(end)} 行（原文共 ${String(expanded.total)} 行）：\n` +
            expanded.lines.map((line, index) => `${String(input.offset + index)}\t${line}`).join('\n'),
        );
      } catch (error) {
        yield result(`无法展开完整工具结果：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

interface RangeOutcome {
  readonly lines: readonly string[];
  readonly total: number;
  readonly interrupted: boolean;
}

async function readRange(
  blobs: BlobStore,
  ref: BlobRef,
  offset: number,
  limit: number,
  signal: AbortLike,
): Promise<RangeOutcome> {
  if (signal.aborted) return { lines: [], total: 0, interrupted: true };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const selected: string[] = [];
  let pending = '';
  let total = 0;
  const state = { interrupted: false };
  const onAbort = (): void => {
    state.interrupted = true;
  };
  signal.addEventListener('abort', onAbort);

  const accept = (line: string): void => {
    total += 1;
    if (total >= offset && selected.length < limit) selected.push(clip(line));
  };
  const consume = (text: string): void => {
    pending += text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      accept(line.endsWith('\r') ? line.slice(0, -1) : line);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  };

  try {
    for await (const chunk of blobs.open(ref)) {
      consume(decoder.decode(chunk, { stream: true }));
      if (state.interrupted) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (!state.interrupted) {
    consume(decoder.decode());
    if (pending !== '') accept(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
  }
  return { lines: selected, total, interrupted: state.interrupted };
}

const clip = (line: string): string =>
  line.length <= MAX_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_LINE_CHARS)} […本行还有 ${String(line.length - MAX_LINE_CHARS)} 个字符]`;

const result = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text }],
});
