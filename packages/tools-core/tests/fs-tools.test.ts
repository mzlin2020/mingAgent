import { localExecutionWorld } from '@xm/tool-runtime';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultBlock, ToolProgress } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { BlobStore, RegisteredTool, ToolContext } from '@xm/kernel';
import { MemoryBlobStore, defineTool } from '@xm/kernel';
import { nodeCheckpointer, nodeCheckpointRestorer } from '@xm/tool-runtime';
import {
  coreTools,
  fsListTool,
  fsReadTool,
  fsWriteTool,
  shellExecTool,
} from '@xm/tools-core';

let dir: string;

const ctx = (aborted = false): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: dir,
  executor: localExecutionWorld,
});

/** 工具收到的一定是网关解析过的绝对路径，用例里也照这个前提喂 */
async function run(tool: RegisteredTool, input: unknown, c = ctx()): Promise<string> {
  const out: ToolProgress[] = [];
  for await (const p of tool.execute(input, c)) out.push(p);
  const last = out.at(-1);
  if (last?.kind !== 'result') throw new Error('工具最后一条必须是 result');
  return textOf(last.forModel);
}

const textOf = (blocks: readonly ResultBlock[]): string =>
  blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-fs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fs.read', () => {
  it('带行号返回，行号从 1 起', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const out = await run(fsReadTool(), { path: join(dir, 'a.txt') });
    expect(out).toBe('1\tone\n2\ttwo\n3\tthree');
  });

  it('offset / limit 按行取，行号仍然是文件里的真实行号', async () => {
    await writeFile(join(dir, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const out = await run(fsReadTool(), { path: join(dir, 'a.txt'), offset: 2, limit: 2 });
    expect(out).toBe('2\tl2\n3\tl3');
  });

  it('🔴 二进制文件不吐乱码 —— 乱码进上下文既费预算又误导判断', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(await run(fsReadTool(), { path: join(dir, 'bin') })).toMatch(/二进制/);
  });

  it('空文件如实说是空的，不返回空字符串', async () => {
    await writeFile(join(dir, 'empty'), '');
    expect(await run(fsReadTool(), { path: join(dir, 'empty') })).toMatch(/空文件/);
  });

  it('目录被明确拒绝并指路到 fs.list', async () => {
    expect(await run(fsReadTool(), { path: dir })).toMatch(/fs\.list/);
  });

  it('🔴 大文件读到上限就停，并给出继续读的 offset', async () => {
    // 1 MB，超过 512 KB 的读取上限
    const line = `${'x'.repeat(99)}\n`;
    await writeFile(join(dir, 'big.txt'), line.repeat(11_000));
    const out = await run(fsReadTool(), { path: join(dir, 'big.txt') });
    expect(out).toMatch(/offset=\d+/);
    // 真的没把整份读进来
    expect(out.length).toBeLessThan(700 * 1024);
  });

  it('极长的单行就地截断 —— 否则行号毫无意义', async () => {
    await writeFile(join(dir, 'min.js'), `${'a'.repeat(5000)}\nnext\n`);
    const out = await run(fsReadTool(), { path: join(dir, 'min.js') });
    expect(out).toMatch(/本行还有 3000 个字符/);
    expect(out).toMatch(/2\tnext/);
  });
});

describe('fs.list', () => {
  it('列出条目并标注类型', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'x');
    await writeFile(join(dir, 'README.md'), 'hi');
    const out = await run(fsListTool(), { path: dir });
    expect(out).toMatch(/README\.md\s+2 B/);
    expect(out).toMatch(/src\//);
  });

  it('🔴 .git / node_modules 被列出但不展开 —— 悄悄跳过与悄悄截断是同一类错误', async () => {
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    const out = await run(fsListTool(), { path: dir, depth: 3 });
    expect(out).toMatch(/node_modules\/\s+（未展开）/);
    expect(out).not.toMatch(/index\.js/);
  });

  it('符号链接被标出来 —— 它的判权目标可能落在目录之外', async () => {
    await writeFile(join(dir, 'real.txt'), 'x');
    try {
      await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'EPERM') return;
      throw e;
    }
    expect(await run(fsListTool(), { path: dir })).toMatch(/link\.txt\s+→ 符号链接/);
  });

  it('depth 递归', async () => {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'deep.txt'), 'x');
    expect(await run(fsListTool(), { path: dir, depth: 1 })).not.toMatch(/deep\.txt/);
    expect(await run(fsListTool(), { path: dir, depth: 3 })).toMatch(/deep\.txt/);
  });

  it('空目录如实说', async () => {
    expect(await run(fsListTool(), { path: dir })).toMatch(/空目录/);
  });
});

describe('fs.write', () => {
  it('写入并创建父目录', async () => {
    const target = join(dir, 'deep', 'nested', 'x.md');
    await run(fsWriteTool(), { path: target, content: '# hi\n' });
    expect(await readFile(target, 'utf8')).toBe('# hi\n');
  });

  it('覆盖既有文件，并在回复里说清是覆盖还是新建', async () => {
    const target = join(dir, 'x.md');
    expect(await run(fsWriteTool(), { path: target, content: 'a' })).toMatch(/已写入/);
    expect(await run(fsWriteTool(), { path: target, content: 'b' })).toMatch(/已覆盖/);
    expect(await readFile(target, 'utf8')).toBe('b');
  });

  it('🔴 写完不留临时文件 —— 原子写的临时文件与目标同目录', async () => {
    await run(fsWriteTool(), { path: join(dir, 'x.md'), content: 'a' });
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('🔴 已经取消时不写 —— 而且要说出来，不能静默成功', async () => {
    const target = join(dir, 'x.md');
    expect(await run(fsWriteTool(), { path: target, content: 'a' }, ctx(true))).toMatch(/已取消/);
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('超大内容被拒绝', async () => {
    const out = await run(fsWriteTool(), { path: join(dir, 'x'), content: 'a'.repeat(6 * 1024 * 1024) });
    expect(out).toMatch(/超过单次上限/);
  });
});

describe('工具声明', () => {
  it('🔴 每个碰路径的工具都声明了 pathInputs —— 漏了就等于所有路径规则匹配不上', () => {
    for (const t of coreTools({ os: 'linux', tempDir: tmpdir() })) {
      const touchesPath = t.descriptor.capabilities.some((c) => c.startsWith('fs.'));
      expect(t.pathInputs.length, t.descriptor.name).toBeGreaterThan(touchesPath ? 0 : -1);
    }
  });

  it('都声明了资源；共享进程或 Git 工作树状态的工具显式串行', () => {
    for (const t of coreTools({ os: 'linux', tempDir: tmpdir() })) {
      // shell.exec 是**显式**声明的 exclusive：一条命令能改动的东西无法从入参判断，
      // Git 工具共享 index/HEAD；与同仓库的其它调用并发同样是数据竞争。
      const want = t.descriptor.name === 'shell.exec' || t.descriptor.group === 'git'
        ? 'exclusive'
        : 'parallel';
      expect(t.descriptor.concurrency, t.descriptor.name).toBe(want);
    }
  });
});

describe('写前还原点', () => {
  const blobs = (): MemoryBlobStore => new MemoryBlobStore(sha256);

  it('🔴 覆盖之前存下旧内容', async () => {
    const store = blobs();
    const target = join(dir, 'x.md');
    await writeFile(target, 'OLD');

    const record = await nodeCheckpointer({ blobs: store }).before(
      fsWriteTool(),
      { path: target, content: 'NEW' },
      ctx(),
      [{ capability: 'fs.write', target }],
    );

    expect(record?.record?.kind).toBe('fs');
    expect(record?.record?.manifestRef).toBeDefined();
    expect(record?.record?.ref).toMatch(/^sha256:[a-f0-9]{64}:\d+$/);
    expect(record?.record?.label).toContain('3 字节');
  });

  it('新建文件也留痕 —— 回退等于"删掉它"，不记就无从知道该删还是该恢复', async () => {
    const record = await nodeCheckpointer({ blobs: blobs() }).before(
      fsWriteTool(),
      { path: join(dir, 'brand-new.md'), content: 'x' },
      ctx(),
      [{ capability: 'fs.write', target: join(dir, 'brand-new.md') }],
    );
    expect(record?.record?.label).toContain('原本不存在');
  });

  it('只读工具不建还原点', async () => {
    const record = await nodeCheckpointer({ blobs: blobs() }).before(
      fsReadTool(),
      { path: join(dir, 'x') },
      ctx(),
      [{ capability: 'fs.read', target: join(dir, 'x') }],
    );
    expect(record).toBeUndefined();
  });

  /**
   * 判据换成主张之后白拿的一格：`shell.exec` 静态声明的只有 `shell.exec`，
   * 按能力声明判的话 `rm foo.txt` 一个还原点都不会有。
   */
  it('🔴 经由 shell.exec 发生的删除也有还原点', async () => {
    const target = join(dir, 'doomed.md');
    await writeFile(target, 'OLD');
    const record = await nodeCheckpointer({ blobs: blobs() }).before(
      shellExecTool({ os: 'linux' }),
      { argv: ['rm', target] },
      ctx(),
      [
        { capability: 'shell.exec', target: `rm ${target}` },
        { capability: 'fs.delete', target },
      ],
    );
    expect(record?.record?.label).toContain('3 字节');
  });

  it('目录树形成一个结构化还原点', async () => {
    const store = blobs();
    await writeFile(join(dir, 'inside.txt'), 'OLD');
    const record = await nodeCheckpointer({ blobs: store }).before(
      shellExecTool({ os: 'linux' }),
      { argv: ['rm', '-rf', dir] },
      ctx(),
      [{ capability: 'fs.delete', target: dir }],
    );
    expect(record?.record?.manifestRef).toBeDefined();
    const manifest = await nodeCheckpointRestorer(store).inspect(record!.record!.manifestRef!);
    expect(manifest.targets[0]).toMatchObject({ kind: 'directory', path: dir });
    expect(record?.warnings).toEqual([]);
  });

  it('🔴 判据来自这次调用的主张，不是一份工具名单', async () => {
    // 一个我们从没听说过的工具，只要主张了 fs.write，就一样有还原点
    const stranger = defineTool({
      name: 'plugin.mangle',
      group: 'plugin',
      description: '第三方工具',
      inputSchema: (await import('zod')).z.strictObject({ file: (await import('zod')).z.string() }),
      risk: 'high',
      capabilities: ['fs.write'],
      pathInputs: ['file'],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *execute() {
        yield { kind: 'result' as const, forModel: [] };
      },
    });
    const target = join(dir, 'y.md');
    await writeFile(target, 'OLD');
    const record = await nodeCheckpointer({ blobs: blobs() }).before(stranger, { file: target }, ctx(), [
      { capability: 'fs.write', target },
    ]);
    expect(record).toBeDefined();
  });

  it('🔴 已存在目标读不到时失败关闭，不冒充“原本不存在”', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const target = join(dir, 'private.md');
    await expect(
      nodeCheckpointer({
        blobs: blobs(),
        statFile: (() => Promise.reject(denied)) as typeof import('node:fs/promises').stat,
      }).before(fsWriteTool(), { path: target, content: 'NEW' }, ctx(), [
        { capability: 'fs.write', target },
      ]),
    ).rejects.toThrow('denied');
  });

  it('大文件流式进入 BlobStore，不再因固定上限失去还原点', async () => {
    const target = join(dir, 'large.bin');
    const store = blobs();
    await writeFile(target, Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    const result = await nodeCheckpointer({ blobs: store }).before(
      fsWriteTool(),
      { path: target, content: 'NEW' },
      ctx(),
      [
      { capability: 'fs.write', target },
      ],
    );
    const manifest = await nodeCheckpointRestorer(store).inspect(result!.record!.manifestRef!);
    expect(manifest.targets[0]).toMatchObject({ kind: 'file', content: { size: 8 * 1024 * 1024 + 1 } });
    expect(result?.warnings).toEqual([]);
  });

  it('blob persistence failure for an existing file rejects execution', async () => {
    const target = join(dir, 'blob-fail.md');
    await writeFile(target, 'OLD');
    const failedBlobs = {
      put: () => Promise.reject(new Error('blob unavailable')),
      putStream: () => Promise.reject(new Error('blob unavailable')),
      get: () => Promise.resolve(undefined),
    } as unknown as BlobStore;
    await expect(
      nodeCheckpointer({ blobs: failedBlobs }).before(fsWriteTool(), { path: target, content: 'NEW' }, ctx(), [
        { capability: 'fs.write', target },
      ]),
    ).rejects.toThrow('blob unavailable');
  });
});

/** MemoryBlobStore 要注入哈希函数（内核没有 crypto） */
async function sha256(data: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}
