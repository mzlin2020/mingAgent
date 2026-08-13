import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool, WorkspaceIndex, WorkspaceIndexState } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { textSearchTool, type TextSearchOptions } from './search-text.js';

export const SEARCH_SYMBOL = 'search.symbol';
export const SEARCH_INDEXED = 'search.indexed';

const Input = z.strictObject({
  query: z.string().min(1).max(1000),
  path: z.string().min(1).default('.').describe('要查询并按工作区隔离的目录'),
  maxResults: z.number().int().min(1).max(1000).default(100),
});

export interface IndexSearchOptions extends TextSearchOptions {
  readonly index: WorkspaceIndex;
}

export const indexSearchTools = (options: IndexSearchOptions): readonly RegisteredTool[] => [
  symbolSearchTool(options),
  indexedTextSearchTool(options),
];

export const symbolSearchTool = (options: IndexSearchOptions): RegisteredTool =>
  defineTool({
    name: SEARCH_SYMBOL,
    group: 'search',
    description:
      '按名称查找 TypeScript/TSX/JavaScript/JSX 的 tree-sitter 符号。索引未就绪或损坏时自动回退 ripgrep。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      let state = stateOf(options.index, input.path);
      if (state === 'ready') {
        try {
          state = (await options.index.refresh(input.path, ctx.signal)).state;
          if (state !== 'ready') throw new Error('索引增量刷新未完成。');
          const symbols = options.index.searchSymbols(input.path, input.query, input.maxResults);
          yield jsonResult({ ok: true, source: 'tree-sitter-index', state, symbols });
          return;
        } catch {
          // 索引查询失败必须走同一条即时退路；下面会同时触发重建。
        }
      }
      startRefresh(options.index, input.path, ctx.signal);
      yield* fallback(options, input, ctx, state);
    },
  });

export const indexedTextSearchTool = (options: IndexSearchOptions): RegisteredTool =>
  defineTool({
    name: SEARCH_INDEXED,
    group: 'search',
    description:
      '用 FTS5 trigram 做不区分大小写的字面量全文查询；短查询、冷索引、损坏或构建中自动回退 ripgrep。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      let state = stateOf(options.index, input.path);
      if (state === 'ready' && Array.from(input.query).length >= 3) {
        try {
          state = (await options.index.refresh(input.path, ctx.signal)).state;
          if (state !== 'ready') throw new Error('索引增量刷新未完成。');
          const matches = options.index.searchText(input.path, input.query, input.maxResults);
          yield jsonResult({ ok: true, source: 'fts5-index', state, matches });
          return;
        } catch {
          // 与符号查询相同：索引是可丢缓存，失败不应泄漏成搜索不可用。
        }
      }
      startRefresh(options.index, input.path, ctx.signal);
      yield* fallback(options, input, ctx, state);
    },
  });

async function* fallback(
  options: IndexSearchOptions,
  input: z.infer<typeof Input>,
  ctx: Parameters<RegisteredTool['execute']>[1],
  state: WorkspaceIndexState,
): AsyncIterable<ToolProgress> {
  const tool = textSearchTool(
    options.executable === undefined ? {} : { executable: options.executable },
  );
  for await (const progress of tool.execute(
    {
      pattern: escapeRegex(input.query),
      path: input.path,
      caseSensitive: false,
      maxResults: input.maxResults,
    },
    ctx,
  )) {
    if (progress.kind !== 'result') {
      yield progress;
      continue;
    }
    const blocks = progress.forModel.map((block) =>
      block.type === 'text'
        ? { ...block, text: `[source: ripgrep-fallback; indexState: ${state}]\n${block.text}` }
        : block,
    );
    yield { ...progress, forModel: blocks };
  }
}

function startRefresh(
  index: WorkspaceIndex,
  root: string,
  signal: Parameters<WorkspaceIndex['refresh']>[1],
): void {
  void index.refresh(root, signal).catch(() => undefined);
}

function stateOf(index: WorkspaceIndex, root: string): WorkspaceIndexState {
  try {
    return index.state(root);
  } catch {
    return 'failed';
  }
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const jsonResult = (value: unknown): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text: JSON.stringify(value) }],
});
