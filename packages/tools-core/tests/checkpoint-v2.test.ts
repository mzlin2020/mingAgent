import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_MANIFEST_MIME,
  CheckpointManifestV2,
  newSessionId,
  type BlobRef,
} from '@xm/contracts';
import { MemoryBlobStore, type BlobStore, type PermissionClaim, type ToolContext } from '@xm/kernel';
import { nodeCheckpointer, nodeCheckpointRestorer } from '@xm/tool-runtime';
import { fsWriteTool } from '@xm/tools-core';

let root: string;
let store: MemoryBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xm-checkpoint-v2-'));
  store = new MemoryBlobStore(sha256);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Checkpoint v2', () => {
  it('一个 manifest 恢复文件、目录、空目录和原本不存在的多个目标', async () => {
    const standalone = join(root, 'standalone.bin');
    const tree = join(root, 'tree');
    const missing = join(root, 'new.txt');
    await writeFile(standalone, Buffer.from([0, 1, 0xfe, 0xff]));
    await mkdir(join(tree, 'nested', 'empty'), { recursive: true });
    await writeFile(join(tree, 'nested', 'old.txt'), 'OLD');

    const result = await checkpoint([
      { capability: 'fs.write', target: standalone },
      { capability: 'fs.delete', target: tree },
      { capability: 'fs.write', target: missing },
    ]);
    const manifestRef = result!.record!.manifestRef!;
    const manifest = await nodeCheckpointRestorer(store).inspect(manifestRef);
    expect(manifest.targets).toHaveLength(3);

    await writeFile(standalone, 'NEW');
    await rm(tree, { recursive: true });
    await mkdir(tree);
    await writeFile(join(tree, 'wrong.txt'), 'wrong');
    await writeFile(missing, 'created');

    await nodeCheckpointRestorer(store).restore(manifestRef);
    expect([...await readFile(standalone)]).toEqual([0, 1, 0xfe, 0xff]);
    expect(await readFile(join(tree, 'nested', 'old.txt'), 'utf8')).toBe('OLD');
    expect(await readdir(join(tree, 'nested', 'empty'))).toEqual([]);
    await expect(readFile(join(tree, 'wrong.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('内容总量超预算时在落盘前失败关闭，不先写出一堆不可达 blob', async () => {
    const huge = join(root, 'huge.bin');
    await writeFile(huge, 'x');
    let streamed = 0;

    /*
     * 用假的 stat 报一个 1 GiB 的文件，不真写 1 GiB。旧实现完全不看内容总量：
     * `rm -rf node_modules` 会把整棵树先流进 BlobStore，几个 GB、几分钟，最后才在
     * 条目数上限处失败——而已写入的 blob 不回滚，GC 又还没实现（ADR-0043 补记）。
     */
    await expect(
      checkpoint([{ capability: 'fs.delete', target: huge }], {
        statFile: (() =>
          Promise.resolve({
            size: 1024 * 1024 * 1024,
            isFile: () => true,
            isDirectory: () => false,
          })) as unknown as NonNullable<Parameters<typeof nodeCheckpointer>[0]['statFile']>,
        openFileStream: () => {
          streamed += 1;
          return (async function* () {
            await Promise.resolve();
            yield new Uint8Array([1]);
          })();
        },
      }),
    ).rejects.toThrow(/超过 .* 字节上限/u);

    expect(streamed).toBe(0);
  });

  it('父目录目标覆盖子目标，manifest 不保存同一棵树两次', async () => {
    const tree = join(root, 'tree');
    const child = join(tree, 'child.txt');
    await mkdir(tree);
    await writeFile(child, 'x');
    const result = await checkpoint([
      { capability: 'fs.delete', target: tree },
      { capability: 'fs.write', target: child },
    ]);
    const manifest = await nodeCheckpointRestorer(store).inspect(result!.record!.manifestRef!);
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0]).toMatchObject({ kind: 'directory', path: tree });
  });

  it('任何内容 blob 缺失时在碰磁盘前失败关闭', async () => {
    const mustRemain = join(root, 'must-remain.txt');
    const other = join(root, 'other.txt');
    await writeFile(mustRemain, 'SAFE');
    await writeFile(other, 'CURRENT');
    const missingRef: BlobRef = {
      hash: 'f'.repeat(64),
      mime: 'application/octet-stream',
      size: 3,
    };
    const manifest = CheckpointManifestV2.parse({
      version: 2,
      targets: [
        { kind: 'missing', path: mustRemain },
        { kind: 'file', path: other, content: missingRef },
      ],
    });
    const ref = await store.put(
      new TextEncoder().encode(JSON.stringify(manifest)),
      CHECKPOINT_MANIFEST_MIME,
    );

    await expect(nodeCheckpointRestorer(store).restore(ref)).rejects.toThrow(/缺失|大小/u);
    expect(await readFile(mustRemain, 'utf8')).toBe('SAFE');
    expect(await readFile(other, 'utf8')).toBe('CURRENT');
  });

  it('多文件应用半途失败后可重试并收敛到同一份快照', async () => {
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    await writeFile(first, 'OLD-1');
    await writeFile(second, 'OLD-2');
    const result = await checkpoint([
      { capability: 'fs.write', target: first },
      { capability: 'fs.write', target: second },
    ]);
    await writeFile(first, 'NEW-1');
    await writeFile(second, 'NEW-2');

    let opens = 0;
    const failsOnSecondApply: BlobStore = {
      put: (data, mime, name) => store.put(data, mime, name),
      putStream: (data, mime, name) => store.putStream(data, mime, name),
      stat: (ref) => store.stat(ref),
      close: () => Promise.resolve(),
      async *open(ref) {
        opens += 1;
        // 1=manifest，2/3=写盘前完整校验，4=应用第一个文件，5=应用第二个文件。
        if (opens === 5) throw new Error('injected restore failure');
        yield* store.open(ref);
      },
    };
    const manifestRef = result!.record!.manifestRef!;
    await expect(nodeCheckpointRestorer(failsOnSecondApply).restore(manifestRef)).rejects.toThrow('injected');
    expect(await readFile(first, 'utf8')).toBe('OLD-1');
    expect(await readFile(second, 'utf8')).toBe('NEW-2');

    await nodeCheckpointRestorer(store).restore(manifestRef);
    expect(await readFile(first, 'utf8')).toBe('OLD-1');
    expect(await readFile(second, 'utf8')).toBe('OLD-2');
  });
});

const checkpoint = (
  claims: readonly PermissionClaim[],
  options: Partial<Parameters<typeof nodeCheckpointer>[0]> = {},
) =>
  nodeCheckpointer({ blobs: store, ...options }).before(
    fsWriteTool(),
    { path: claims[0]!.target, content: 'unused' },
    context(),
    claims,
  );

const context = (): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: root,
  executor: 'local',
});

async function sha256(data: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}
