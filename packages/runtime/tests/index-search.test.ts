import { localExecutionWorld } from '@xm/tool-runtime';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import type { ToolContext, WorkspaceIndex, WorkspaceIndexRefresh } from '@xm/kernel';
import { openWorkspaceIndex } from '@xm/storage';
import { indexedTextSearchTool, symbolSearchTool } from '@xm/tools-core';

const roots: string[] = [];
const indexes: WorkspaceIndex[] = [];
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-g index query fallback', () => {
  it('冷索引立即回退文本搜索；建完后 FTS 不遗漏同一字面量结果，符号来自 tree-sitter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-index-query-'));
    const data = await mkdtemp(join(tmpdir(), 'xm-index-query-data-'));
    roots.push(root, data);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'a.txt'), 'exact needle one\n');
    await writeFile(
      join(root, 'src', 'code.ts'),
      'export function indexedFunction(): string { return "exact needle two"; }\n',
    );
    const index = await openWorkspaceIndex(join(data, 'index.sqlite'));
    indexes.push(index);
    const tool = indexedTextSearchTool({ index, os: 'linux' });

    const cold = await textOf(tool.execute(
      { query: 'exact needle', path: root, maxResults: 20 },
      context(root),
    ));
    expect(cold).toContain('source: text-fallback');
    expect(cold).toContain('a.txt:1:1');
    expect(cold).toContain('src/code.ts:1:53');

    await index.refresh(root, neverAborts);
    const readyText = await textOf(tool.execute(
      { query: 'exact needle', path: root, maxResults: 20 },
      context(root),
    ));
    const ready = JSON.parse(readyText) as { source: string; matches: { path: string }[] };
    expect(ready.source).toBe('fts5-index');
    expect(ready.matches.map((match) => match.path)).toEqual(['a.txt', 'src/code.ts']);

    const symbols = JSON.parse(await textOf(symbolSearchTool({ index, os: 'linux' }).execute(
      { query: 'indexed', path: root, maxResults: 20 },
      context(root),
    ))) as { source: string; symbols: { name: string }[] };
    expect(symbols).toMatchObject({ source: 'tree-sitter-index' });
    expect(symbols.symbols.map((symbol) => symbol.name)).toEqual(['indexedFunction']);

    /*
     * 改文件之后，下一次查询**允许**先给出旧结果——查询不再同步等一次全量扫描
     * （ADR-0051）。收敛由后台刷新负责；这里显式等它，断言的是"会收敛"，
     * 而不是"每次查询都当场重扫"。
     */
    await writeFile(
      join(root, 'src', 'code.ts'),
      'export function refreshedFunction(): string { return "exact needle three"; }\n',
    );
    await index.refresh(root, neverAborts);
    const refreshed = JSON.parse(await textOf(symbolSearchTool({ index, os: 'linux' }).execute(
      { query: 'Function', path: root, maxResults: 20 },
      context(root),
    ))) as { symbols: { name: string }[] };
    expect(refreshed.symbols.map((symbol) => symbol.name)).toEqual(['refreshedFunction']);
  });

  it('短查询即使索引 ready 也自动使用文本搜索，不把 FTS 限制伪装成零结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-index-short-'));
    const data = await mkdtemp(join(tmpdir(), 'xm-index-short-data-'));
    roots.push(root, data);
    await writeFile(join(root, 'a.txt'), 'xy\n');
    const index = await openWorkspaceIndex(join(data, 'index.sqlite'));
    indexes.push(index);
    await index.refresh(root, neverAborts);
    const output = await textOf(indexedTextSearchTool({ index, os: 'linux' }).execute(
      { query: 'xy', path: root, maxResults: 20 },
      context(root),
    ));
    expect(output).toContain('source: text-fallback');
    expect(output).toContain('a.txt:1:1');
  });

  it('查询不等待刷新完成：refresh 永不结束时查询仍然按时返回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-index-nonblocking-'));
    const data = await mkdtemp(join(tmpdir(), 'xm-index-nonblocking-data-'));
    roots.push(root, data);
    await writeFile(join(root, 'a.txt'), 'exact needle one\n');
    const real = await openWorkspaceIndex(join(data, 'index.sqlite'));
    indexes.push(real);
    await real.refresh(root, neverAborts);

    /*
     * 旧实现在查询前 `await index.refresh(...)`，即每一次 search.indexed / search.symbol
     * 都同步做一遍全仓扫描。用一个永不 resolve 的 refresh 把这件事变成可判定的：
     * 只要还在等它，这个用例就会超时。
     */
    let refreshCalls = 0;
    const stalled: WorkspaceIndex = {
      state: (target) => real.state(target),
      stats: () => real.stats(),
      refresh: (): Promise<WorkspaceIndexRefresh> => {
        refreshCalls += 1;
        return new Promise<WorkspaceIndexRefresh>(() => undefined);
      },
      clear: () => real.clear(),
      searchText: (query) => real.searchText(query),
      searchSymbols: (query) => real.searchSymbols(query),
      close: () => Promise.resolve(),
    };

    const output = await withTimeout(
      textOf(indexedTextSearchTool({ index: stalled, os: 'linux' }).execute(
        { query: 'exact needle', path: root, maxResults: 20 },
        context(root),
      )),
      2000,
    );

    expect(JSON.parse(output)).toMatchObject({ source: 'fts5-index' });
    expect(refreshCalls).toBe(1);
  });

  it('path 只收窄结果范围，索引身份仍是会话 cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-index-scope-'));
    const data = await mkdtemp(join(tmpdir(), 'xm-index-scope-data-'));
    roots.push(root, data);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const scopedNeedle = 1;\n');
    await writeFile(join(root, 'docs', 'b.ts'), 'export const scopedNeedle = 2;\n');
    const index = await openWorkspaceIndex(join(data, 'index.sqlite'));
    indexes.push(index);
    await index.refresh(root, neverAborts);

    const scoped = JSON.parse(await textOf(indexedTextSearchTool({ index, os: 'linux' }).execute(
      { query: 'scopedNeedle', path: join(root, 'src'), maxResults: 20 },
      context(root),
    ))) as { source: string; matches: { path: string }[] };

    expect(scoped.source).toBe('fts5-index');
    expect(scoped.matches.map((match) => match.path)).toEqual(['src/a.ts']);
    // 查子目录不会另建一份索引：整个工作区仍然只有一个 root
    expect(index.state(root)).toBe('ready');
    expect(index.state(join(root, 'src'))).toBe('cold');
  });
});

async function textOf(progresses: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const progress of progresses) {
    const result = progress as { kind?: string; forModel?: { type: string; text?: string }[] };
    if (result.kind === 'result' && result.forModel?.[0]?.type === 'text') {
      text = result.forModel[0].text ?? '';
    }
  }
  return text;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`查询在 ${String(ms)}ms 内没有返回，说明它仍在等待索引刷新`));
      }, ms).unref();
    }),
  ]);
}

function context(cwd: string): ToolContext {
  return { sessionId: newSessionId(), cwd, executor: localExecutionWorld, signal: neverAborts };
}

const neverAborts = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
