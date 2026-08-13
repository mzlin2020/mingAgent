import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import {
  CHECKPOINT_MANIFEST_MIME,
  CheckpointManifestV2,
  type BlobRef,
  type CheckpointDirectoryEntry,
  type CheckpointManifestV2 as Manifest,
  type CheckpointTarget,
} from '@xm/contracts';
import type {
  BlobStore,
  CheckpointBeforeResult,
  Checkpointer,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';

const MAX_MANIFEST_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/**
 * 一个还原点允许写进 BlobStore 的内容总字节（ADR-0043 补记）。
 *
 * 原来只限了 manifest 的条目数与自身字节数，**没有限内容总量**。于是模型一句
 * `rm -rf node_modules` 会让运行时先把整棵树逐文件流进 BlobStore——几个 GB、几分钟，
 * 最后才在条目上限处失败关闭。更糟的是已经写入的 blob 不回滚，而 GC 按 ADR-0043 §5
 * 尚未实现，那些字节就永久占着盘。
 *
 * 256 MiB 对真实编辑绰绰有余，对依赖目录/构建产物则会立刻拦下。判断用 `lstat` 的 size
 * **在流式写入之前**做，所以超预算时基本不会先写出一堆不可达 blob。
 */
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;

/** 跨整次调用累计的内容字节预算。 */
interface ContentBudget {
  used: number;
}

export interface NodeCheckpointerOptions {
  readonly blobs: BlobStore;
  /** 测试注入点；生产默认使用 node:fs。 */
  readonly statFile?: typeof stat;
  readonly openFileStream?: (path: string) => AsyncIterable<Uint8Array>;
}

/**
 * v2 文件还原点：一次调用的全部写目标先完整快照，最后只记录一个 manifest。
 * 任一读取或 blob 写入失败都会 reject，因此运行时不会执行工具，也不会留下伪事件。
 */
export const nodeCheckpointer = (options: NodeCheckpointerOptions): Checkpointer => ({
  async before(
    _tool: RegisteredTool,
    _input: unknown,
    ctx: ToolContext,
    claims: readonly PermissionClaim[],
  ): Promise<CheckpointBeforeResult | undefined> {
    if (ctx.signal.aborted) return undefined;
    const paths = collapseTargets(
      claims
        .filter((claim) => claim.capability === 'fs.write' || claim.capability === 'fs.delete')
        .map((claim) => claim.target)
        .filter((target) => target !== ''),
    );
    if (paths.length === 0) return undefined;

    const targets: CheckpointTarget[] = [];
    const budget: ContentBudget = { used: 0 };
    let entries = 0;
    for (const path of paths) {
      const target = await snapshotTarget(path, options, budget);
      entries += target.kind === 'directory' ? target.entries.length + 1 : 1;
      if (entries > MAX_MANIFEST_ENTRIES) {
        throw new Error(`checkpoint manifest 超过 ${String(MAX_MANIFEST_ENTRIES)} 个条目。`);
      }
      targets.push(target);
    }

    const manifest: Manifest = CheckpointManifestV2.parse({ version: 2, targets });
    const encoded = new TextEncoder().encode(JSON.stringify(manifest));
    if (encoded.byteLength > MAX_MANIFEST_BYTES) {
      throw new Error(`checkpoint manifest 超过 ${String(MAX_MANIFEST_BYTES)} 字节。`);
    }
    const manifestRef = await options.blobs.put(
      encoded,
      CHECKPOINT_MANIFEST_MIME,
      'checkpoint-v2.json',
    );
    return {
      record: {
        kind: 'fs',
        ref: refString(manifestRef),
        manifestRef,
        label: labelOf(targets),
      },
      warnings: [],
    };
  },
});

async function snapshotTarget(
  path: string,
  options: NodeCheckpointerOptions,
  budget: ContentBudget,
): Promise<CheckpointTarget> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await (options.statFile ?? stat)(path);
  } catch (error) {
    if (isNotFound(error)) return { kind: 'missing', path };
    throw error;
  }

  if (info.isFile()) {
    chargeBudget(budget, info.size, path);
    return {
      kind: 'file',
      path,
      content: await snapshotFile(path, options.blobs, options.openFileStream),
    };
  }
  if (info.isDirectory()) {
    return { kind: 'directory', path, entries: await snapshotDirectory(path, options, budget) };
  }
  throw new Error(`不能为特殊文件建立还原点：${path}`);
}

/** 先记账再落盘：超预算时基本不会先写出一堆不可达 blob。 */
function chargeBudget(budget: ContentBudget, size: number, path: string): void {
  budget.used += size;
  if (budget.used <= MAX_CONTENT_BYTES) return;
  throw new Error(
    `还原点需要保存的内容超过 ${String(MAX_CONTENT_BYTES)} 字节上限（累计到 ${path} 时已达 ` +
      `${String(budget.used)} 字节）。请把这次操作的目标缩小到更具体的路径。`,
  );
}

async function snapshotDirectory(
  root: string,
  options: NodeCheckpointerOptions,
  budget: ContentBudget,
): Promise<CheckpointDirectoryEntry[]> {
  const entries: CheckpointDirectoryEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        entries.push({ kind: 'symlink', path, link: await readlink(absolute) });
      } else if (info.isDirectory()) {
        entries.push({ kind: 'directory', path });
        await visit(absolute);
      } else if (info.isFile()) {
        chargeBudget(budget, info.size, absolute);
        entries.push({
          kind: 'file',
          path,
          content: await snapshotFile(absolute, options.blobs, options.openFileStream),
        });
      } else {
        throw new Error(`目录中包含不能恢复的特殊文件：${absolute}`);
      }
      if (entries.length > MAX_MANIFEST_ENTRIES) {
        throw new Error(`checkpoint manifest 超过 ${String(MAX_MANIFEST_ENTRIES)} 个条目。`);
      }
    }
  };
  await visit(root);
  return entries;
}

const snapshotFile = (
  path: string,
  blobs: BlobStore,
  openFileStream: NodeCheckpointerOptions['openFileStream'],
): Promise<BlobRef> =>
  blobs.putStream(
    (openFileStream ?? ((target) => createReadStream(target)))(path),
    'application/octet-stream',
    basename(path),
  );

function collapseTargets(input: readonly string[]): string[] {
  const sorted = [...new Set(input.map((path) => resolve(path)))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted.slice(0, index).some((parent) => {
        const rel = relative(parent, candidate);
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      }),
  );
}

const labelOf = (targets: readonly CheckpointTarget[]): string => {
  const summary = targets
    .map((target) => {
      if (target.kind === 'missing') return `${target.path}（原本不存在）`;
      if (target.kind === 'file') return `${target.path}（${String(target.content.size)} 字节）`;
      return `${target.path}（目录，${String(target.entries.length)} 个条目）`;
    })
    .join('；');
  return summary.length <= 1000 ? summary : `${summary.slice(0, 997)}…`;
};

const refString = (ref: BlobRef): string => `sha256:${ref.hash}:${String(ref.size)}`;
const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
