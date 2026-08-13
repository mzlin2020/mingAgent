import { relative } from 'node:path';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { AbortLike, RegisteredTool, ToolContext, WorkspaceIndex, WorkspaceIndexState } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { textSearchTool, type TextSearchOptions } from './search-text.js';

export const SEARCH_SYMBOL = 'search.symbol';
export const SEARCH_INDEXED = 'search.indexed';

const Input = z.strictObject({
  query: z.string().min(1).max(1000),
  path: z.string().min(1).default('.').describe('限定查询范围的目录或文件，默认整个工作区'),
  maxResults: z.number().int().min(1).max(1000).default(100),
});

/** 后台刷新不挂在任何一次工具调用上（见 startRefresh 的注释）。 */
const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export interface IndexSearchOptions extends TextSearchOptions {
  readonly index: WorkspaceIndex;
  /**
   * 后台增量刷新的取消源。装配层传应用级信号（桌面端是 `background`），
   * 省略时永不取消——**绝不能**传某一次工具调用的 signal，见 `startRefresh`。
   */
  readonly backgroundSignal?: AbortLike;
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
      '按名称查找 TypeScript/TSX/JavaScript/JSX 的 tree-sitter 符号。索引未就绪或损坏时自动回退文本搜索。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const scope = queryScope(options, input, ctx);
      if (scope.state === 'ready') {
        try {
          const symbols = options.index.searchSymbols(scope.query);
          startRefresh(options, scope.query.root);
          yield jsonResult({ ok: true, source: 'tree-sitter-index', state: scope.state, symbols });
          return;
        } catch {
          // 索引查询失败必须走同一条即时退路；下面会同时触发重建。
        }
      }
      startRefresh(options, scope.query.root);
      yield* fallback(options, input, ctx, scope.state);
    },
  });

export const indexedTextSearchTool = (options: IndexSearchOptions): RegisteredTool =>
  defineTool({
    name: SEARCH_INDEXED,
    group: 'search',
    description:
      '用 FTS5 trigram 做不区分大小写的字面量全文查询；短查询、冷索引、损坏或构建中自动回退文本搜索。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const scope = queryScope(options, input, ctx);
      // trigram 分词器对 3 字符以下的查询无能为力，那不是"零结果"而是"这条索引答不了"
      if (scope.state === 'ready' && Array.from(input.query).length >= 3) {
        try {
          const matches = options.index.searchText(scope.query);
          startRefresh(options, scope.query.root);
          yield jsonResult({ ok: true, source: 'fts5-index', state: scope.state, matches });
          return;
        } catch {
          // 与符号查询相同：索引是可丢缓存，失败不应泄漏成搜索不可用。
        }
      }
      startRefresh(options, scope.query.root);
      yield* fallback(options, input, ctx, scope.state);
    },
  });

/**
 * 工作区身份来自会话 cwd，不是模型给的 `path`（ADR-0051）。
 *
 * 原来直接把 `input.path` 当索引 root：模型查一次子目录就会另建一整份索引（连全文副本
 * 一起复制），而装配层预热用的是会话 cwd，两个 key 对不上，预热出来的索引永远命中不到。
 * 现在 `path` 只降级为结果前缀过滤。
 */
function queryScope(
  options: IndexSearchOptions,
  input: z.infer<typeof Input>,
  ctx: ToolContext,
): {
  readonly state: WorkspaceIndexState;
  readonly query: { readonly root: string; readonly query: string; readonly limit: number; readonly pathPrefix?: string };
} {
  const root = ctx.cwd;
  const prefix = relativePrefix(root, input.path);
  return {
    state: stateOf(options.index, root),
    query: {
      root,
      query: input.query,
      limit: input.maxResults,
      ...(prefix === undefined ? {} : { pathPrefix: prefix }),
    },
  };
}

/** `path` 落在工作区之外（或就是工作区本身）时不加前缀，由 fallback 去处理范围。 */
function relativePrefix(root: string, path: string): string | undefined {
  const rel = relative(root, path).split('\\').join('/');
  if (rel === '' || rel.startsWith('..') || rel.includes(':')) return undefined;
  return rel;
}

async function* fallback(
  options: IndexSearchOptions,
  input: z.infer<typeof Input>,
  ctx: ToolContext,
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
        ? { ...block, text: `[source: text-fallback; indexState: ${state}]\n${block.text}` }
        : block,
    );
    yield { ...progress, forModel: blocks };
  }
}

/**
 * 触发一次后台增量刷新——**不等它**。
 *
 * 两处都改过（ADR-0051）：
 *
 * 一、原来查询前是 `await index.refresh(...)`，也就是每一次 search.symbol /
 *     search.indexed 都同步做一遍全仓扫描（枚举 + 逐文件 stat + 变更文件重解析）。
 *     ADR-0047 §3 写的是"只后台触发一次，不阻塞会话"，实现与它正好相反，
 *     结果索引不但没省事，还比直接 ripgrep 更慢。
 *
 * 二、原来传的是 `ctx.signal`，turn 一结束就被取消，于是索引几乎永远建不完、
 *     永远停在 stale。后台任务必须挂在应用级信号上。
 */
function startRefresh(options: IndexSearchOptions, root: string): void {
  if (!dueForRefresh(options.index, root)) return;
  void options.index.refresh(root, options.backgroundSignal ?? NEVER_ABORTS).catch(() => undefined);
}

/**
 * 每次查询都发起一次全仓扫描仍然太贵——即便不再等它。节流到每个 root 最多 30 秒一次。
 *
 * 状态挂在索引实例上（WeakMap）而不是模块级变量：多个装配、多个测试各自独立，
 * 索引被回收时节流记录一起消失。
 */
const REFRESH_INTERVAL_MS = 30_000;
const lastRefreshAt = new WeakMap<WorkspaceIndex, Map<string, number>>();

function dueForRefresh(index: WorkspaceIndex, root: string): boolean {
  let byRoot = lastRefreshAt.get(index);
  if (byRoot === undefined) {
    byRoot = new Map<string, number>();
    lastRefreshAt.set(index, byRoot);
  }
  const now = Date.now();
  const previous = byRoot.get(root);
  if (previous !== undefined && now - previous < REFRESH_INTERVAL_MS) return false;
  byRoot.set(root, now);
  return true;
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
