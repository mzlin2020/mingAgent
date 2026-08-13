import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import type { ToolContext, WorkspaceIndex } from '@xm/kernel';
import { openWorkspaceIndex } from '@xm/storage';
import { indexedTextSearchTool, symbolSearchTool } from '@xm/tools-core';

const roots: string[] = [];
const indexes: WorkspaceIndex[] = [];
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-g index query fallback', () => {
  it('冷索引立即回退 ripgrep；建完后 FTS 不遗漏同一字面量结果，符号来自 tree-sitter', async () => {
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
    const tool = indexedTextSearchTool({ index });

    const cold = await textOf(tool.execute(
      { query: 'exact needle', path: root, maxResults: 20 },
      context(root),
    ));
    expect(cold).toContain('source: ripgrep-fallback');
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

    const symbols = JSON.parse(await textOf(symbolSearchTool({ index }).execute(
      { query: 'indexed', path: root, maxResults: 20 },
      context(root),
    ))) as { source: string; symbols: { name: string }[] };
    expect(symbols).toMatchObject({ source: 'tree-sitter-index' });
    expect(symbols.symbols.map((symbol) => symbol.name)).toEqual(['indexedFunction']);

    await writeFile(
      join(root, 'src', 'code.ts'),
      'export function refreshedFunction(): string { return "exact needle three"; }\n',
    );
    const refreshed = JSON.parse(await textOf(symbolSearchTool({ index }).execute(
      { query: 'Function', path: root, maxResults: 20 },
      context(root),
    ))) as { symbols: { name: string }[] };
    expect(refreshed.symbols.map((symbol) => symbol.name)).toEqual(['refreshedFunction']);
  });

  it('短查询即使索引 ready 也自动使用 ripgrep，不把 FTS 限制伪装成零结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-index-short-'));
    const data = await mkdtemp(join(tmpdir(), 'xm-index-short-data-'));
    roots.push(root, data);
    await writeFile(join(root, 'a.txt'), 'xy\n');
    const index = await openWorkspaceIndex(join(data, 'index.sqlite'));
    indexes.push(index);
    await index.refresh(root, neverAborts);
    const output = await textOf(indexedTextSearchTool({ index }).execute(
      { query: 'xy', path: root, maxResults: 20 },
      context(root),
    ));
    expect(output).toContain('source: ripgrep-fallback');
    expect(output).toContain('a.txt:1:1');
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

function context(cwd: string): ToolContext {
  return { sessionId: newSessionId(), cwd, executor: 'local', signal: neverAborts };
}

const neverAborts = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
