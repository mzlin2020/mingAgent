import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AbortLike, WorkspaceIndex } from '@xm/kernel';
import { openWorkspaceIndex, type WorkspaceIndexOptions } from '../src/index.js';

const roots: string[] = [];
const indexes: WorkspaceIndex[] = [];
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const hasRipgrep = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
/*
 * 主用例组刻意走**纯 Node 枚举**那条路径（ADR-0051）。
 *
 * 索引原来只能靠 `rg --files` 枚举文件，宿主没有 rg 就整个建不起来——而这套测试当时
 * 全都假定 rg 在，于是"没有 rg 时索引不可用"这件事一次也没被测到。现在把不依赖
 * `.gitignore` 的行为都钉在退路上（它才是普通用户开箱即得的），rg 特有的忽略规则单测。
 */
const nodeWalk: WorkspaceIndexOptions = { ripgrep: 'xm-ripgrep-definitely-missing' };

describe('M2-g workspace index', () => {
  it('冷启动用 FTS5 建全文索引，并由 tree-sitter 提取真实符号', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    expect(index.state(fixture.root)).toBe('cold');
    const refreshed = await index.refresh(fixture.root, neverAborts);
    expect(refreshed).toMatchObject({ state: 'ready', indexed: 3, removed: 0, errors: [] });

    expect(symbols(index, fixture.root, 'hello')).toEqual([
      expect.objectContaining({ name: 'helloWorld', kind: 'function', path: 'src/a.ts', line: 2 }),
    ]);
    expect(symbols(index, fixture.root, 'FakeComment')).toEqual([]);
    expect(text(index, fixture.root, 'shared needle')).toEqual([
      expect.objectContaining({ path: 'README.md', line: 1 }),
      expect.objectContaining({ path: 'src/a.ts', line: 3 }),
    ]);
    expect(await stat(fixture.database)).toBeDefined();
    expect(fixture.database.startsWith(fixture.root)).toBe(false);
    await index.close();
  });

  it('增量跳过未变文件，并收敛修改、删除与重命名', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    await index.refresh(fixture.root, neverAborts);
    expect(await index.refresh(fixture.root, neverAborts)).toMatchObject({ indexed: 0, unchanged: 3 });

    await writeFile(join(fixture.root, 'src', 'a.ts'), 'export const renamed = () => "changed needle";\n');
    const future = new Date(Date.now() + 2000);
    await utimes(join(fixture.root, 'src', 'a.ts'), future, future);
    await rename(join(fixture.root, 'README.md'), join(fixture.root, 'GUIDE.md'));

    const changed = await index.refresh(fixture.root, neverAborts);
    expect(changed).toMatchObject({ state: 'ready', indexed: 2, removed: 1 });
    expect(symbols(index, fixture.root, 'renamed')).toHaveLength(1);
    expect(symbols(index, fixture.root, 'helloWorld')).toHaveLength(0);
    expect(text(index, fixture.root, 'shared needle').map((item) => item.path)).toEqual(['GUIDE.md']);

    await writeFile(join(fixture.root, 'src', 'a.ts'), Buffer.from([0, 1, 2, 3]));
    const later = new Date(Date.now() + 4000);
    await utimes(join(fixture.root, 'src', 'a.ts'), later, later);
    expect(await index.refresh(fixture.root, neverAborts)).toMatchObject({ state: 'ready', removed: 1 });
    expect(symbols(index, fixture.root, 'renamed')).toHaveLength(0);
    expect(text(index, fixture.root, 'changed needle')).toHaveLength(0);
    await index.close();
  });

  it('pathPrefix 只收窄结果，不另建一份索引', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database);
    await index.refresh(fixture.root, neverAborts);

    expect(text(index, fixture.root, 'shared needle', 'src').map((item) => item.path)).toEqual([
      'src/a.ts',
    ]);
    expect(symbols(index, fixture.root, 'hello', 'src')).toHaveLength(1);
    expect(symbols(index, fixture.root, 'hello', 'docs')).toHaveLength(0);
    // 前缀里的 `%` 是字面量，不是通配符
    expect(text(index, fixture.root, 'shared needle', '%')).toHaveLength(0);
    await index.close();
  });

  it('单个文件读不了时整库仍然 ready，只把它记进 errors', async () => {
    const fixture = await workspace();
    const unreadable = join(fixture.root, 'src', 'locked.ts');
    await writeFile(unreadable, 'export function lockedSymbol(): void {}\n');
    await chmod(unreadable, 0o000);
    const stillReadable = await readFile(unreadable).then(
      () => true,
      () => false,
    );
    if (stillReadable) {
      // root 或 Windows 上改权限拦不住读取，这条断言就没有被验证的对象
      await chmod(unreadable, 0o644);
      return;
    }

    const index = await opened(fixture.database);
    const refreshed = await index.refresh(fixture.root, neverAborts);
    await chmod(unreadable, 0o644);

    expect(refreshed.errors).toHaveLength(1);
    expect(refreshed.errors[0]).toContain('locked.ts');
    // 旧行为是 errors 非空即 stale —— 一个读不了的文件就让每次查询都 fallback 并全量重扫
    expect(refreshed.state).toBe('ready');
    expect(index.state(fixture.root)).toBe('ready');
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

  it.runIf(hasRipgrep)('有 ripgrep 时额外遵守 .ignore / .gitignore 规则', async () => {
    const fixture = await workspace();
    const index = await opened(fixture.database, {});
    await writeFile(join(fixture.root, '.ignore'), 'ignored.ts\n');
    await writeFile(join(fixture.root, 'ignored.ts'), 'export function ignoredSymbol() {}\n');
    await index.refresh(fixture.root, neverAborts);
    expect(symbols(index, fixture.root, 'ignoredSymbol')).toHaveLength(0);

    await writeFile(join(fixture.root, '.ignore'), '');
    await index.refresh(fixture.root, neverAborts);
    expect(symbols(index, fixture.root, 'ignoredSymbol')).toHaveLength(1);
    await index.close();
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

const symbols = (index: WorkspaceIndex, root: string, query: string, pathPrefix?: string) =>
  index.searchSymbols({ root, query, limit: 10, ...(pathPrefix === undefined ? {} : { pathPrefix }) });
const text = (index: WorkspaceIndex, root: string, query: string, pathPrefix?: string) =>
  index.searchText({ root, query, limit: 10, ...(pathPrefix === undefined ? {} : { pathPrefix }) });

const neverAborts: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const aborted: AbortLike = { ...neverAborts, aborted: true };
const indexNames = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.subarray(0, 16));

async function opened(path: string, options: WorkspaceIndexOptions = nodeWalk): Promise<WorkspaceIndex> {
  const index = await openWorkspaceIndex(path, options);
  indexes.push(index);
  return index;
}
