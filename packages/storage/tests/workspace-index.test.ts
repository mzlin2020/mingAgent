import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AbortLike, WorkspaceIndex } from '@xm/kernel';
import { openWorkspaceIndex } from '../src/index.js';

const roots: string[] = [];
const indexes: WorkspaceIndex[] = [];
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-g workspace index', () => {
  it('冷启动用 FTS5 建全文索引，并由 tree-sitter 提取真实符号', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    expect(index.state(fixture.root)).toBe('cold');
    const refreshed = await index.refresh(fixture.root, neverAborts);
    expect(refreshed).toMatchObject({ state: 'ready', indexed: 3, removed: 0, errors: [] });

    expect(index.searchSymbols(fixture.root, 'hello', 10)).toEqual([
      expect.objectContaining({ name: 'helloWorld', kind: 'function', path: 'src/a.ts', line: 2 }),
    ]);
    expect(index.searchSymbols(fixture.root, 'FakeComment', 10)).toEqual([]);
    expect(index.searchText(fixture.root, 'shared needle', 10)).toEqual([
      expect.objectContaining({ path: 'README.md', line: 1 }),
      expect.objectContaining({ path: 'src/a.ts', line: 3 }),
    ]);
    expect(await stat(fixture.database)).toBeDefined();
    expect(fixture.database.startsWith(fixture.root)).toBe(false);
    await index.close();
  });

  it('增量跳过未变文件，并收敛修改、删除、重命名与 ignore 规则变化', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    await index.refresh(fixture.root, neverAborts);
    expect(await index.refresh(fixture.root, neverAborts)).toMatchObject({ indexed: 0, unchanged: 3 });

    await writeFile(join(fixture.root, 'src', 'a.ts'), 'export const renamed = () => "changed needle";\n');
    const future = new Date(Date.now() + 2000);
    await utimes(join(fixture.root, 'src', 'a.ts'), future, future);
    await rename(join(fixture.root, 'README.md'), join(fixture.root, 'GUIDE.md'));
    await writeFile(join(fixture.root, '.ignore'), 'ignored.ts\n');
    await writeFile(join(fixture.root, 'ignored.ts'), 'export function ignoredSymbol() {}\n');

    const changed = await index.refresh(fixture.root, neverAborts);
    expect(changed).toMatchObject({ state: 'ready', indexed: 2, removed: 1 });
    expect(index.searchSymbols(fixture.root, 'renamed', 10)).toHaveLength(1);
    expect(index.searchSymbols(fixture.root, 'helloWorld', 10)).toHaveLength(0);
    expect(index.searchSymbols(fixture.root, 'ignoredSymbol', 10)).toHaveLength(0);
    expect(index.searchText(fixture.root, 'shared needle', 10).map((item) => item.path)).toEqual(['GUIDE.md']);

    await writeFile(join(fixture.root, '.ignore'), '');
    await index.refresh(fixture.root, neverAborts);
    expect(index.searchSymbols(fixture.root, 'ignoredSymbol', 10)).toHaveLength(1);

    await writeFile(join(fixture.root, 'src', 'a.ts'), Buffer.from([0, 1, 2, 3]));
    const later = new Date(Date.now() + 4000);
    await utimes(join(fixture.root, 'src', 'a.ts'), later, later);
    expect(await index.refresh(fixture.root, neverAborts)).toMatchObject({ state: 'ready', removed: 1 });
    expect(index.searchSymbols(fixture.root, 'renamed', 10)).toHaveLength(0);
    expect(index.searchText(fixture.root, 'changed needle', 10)).toHaveLength(0);
    await index.close();
  });

  it('取消不把半成品标成 ready；损坏库重开后自动重建为空派生库', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    expect(await index.refresh(fixture.root, aborted)).toMatchObject({ state: 'stale' });
    expect(index.state(fixture.root)).toBe('stale');
    await index.close();

    await writeFile(fixture.database, 'not a sqlite database');
    const repaired = await opened(fixture.database);
    expect(repaired.state(fixture.root)).toBe('cold');
    expect(await repaired.refresh(fixture.root, neverAborts)).toMatchObject({ state: 'ready' });
    expect(indexNames(await readFile(fixture.database))).toContain('SQLite');
    await repaired.close();
  });
});

async function workspace(): Promise<{ root: string; database: string }> {
  const root = await mkdtemp(join(tmpdir(), 'xm-index-workspace-'));
  const data = await mkdtemp(join(tmpdir(), 'xm-index-data-'));
  roots.push(root, data);
  await writeFile(join(root, 'README.md'), 'shared needle in docs\n');
  await writeFile(join(root, 'plain.txt'), 'ordinary text\n');
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'a.ts'),
    '// function FakeComment() {}\nexport function helloWorld(): string {\n  return "shared needle";\n}\n',
  );
  return { root, database: join(data, 'workspace-index.sqlite') };
}

const neverAborts: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const aborted: AbortLike = { ...neverAborts, aborted: true };
const indexNames = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.subarray(0, 16));

async function opened(path: string): Promise<WorkspaceIndex> {
  const index = await openWorkspaceIndex(path);
  indexes.push(index);
  return index;
}
