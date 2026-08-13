import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  CheckpointManifestV2,
  type BlobRef,
  type CheckpointDirectoryEntry,
  type CheckpointManifestV2 as Manifest,
  type CheckpointTarget,
} from '@xm/contracts';
import type { AbortLike, BlobStore, CheckpointRestorer } from '@xm/kernel';
import { readBlob } from '@xm/kernel';

export const nodeCheckpointRestorer = (blobs: BlobStore): CheckpointRestorer => ({
  async inspect(ref) {
    return readManifest(blobs, ref);
  },

  async restore(ref, signal) {
    const manifest = await readManifest(blobs, ref);
    validateManifest(manifest);
    await validateContents(blobs, manifest, signal);
    for (const target of manifest.targets) {
      assertActive(signal);
      await restoreTarget(blobs, target, signal);
    }
  },
});

async function readManifest(blobs: BlobStore, ref: BlobRef): Promise<Manifest> {
  const bytes = await readBlob(blobs, ref);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`checkpoint manifest 不是有效 UTF-8 JSON：${messageOf(error)}`, {
      cause: error,
    });
  }
  return CheckpointManifestV2.parse(raw);
}

function validateManifest(manifest: Manifest): void {
  const roots: string[] = [];
  for (const target of manifest.targets) {
    if (!isAbsolute(target.path)) throw new Error(`checkpoint 目标不是绝对路径：${target.path}`);
    const root = resolve(target.path);
    if (roots.some((seen) => overlaps(seen, root))) {
      throw new Error(`checkpoint manifest 包含重复或重叠目标：${target.path}`);
    }
    roots.push(root);
    if (target.kind === 'directory') validateDirectory(root, target.entries);
  }
}

function validateDirectory(root: string, entries: readonly CheckpointDirectoryEntry[]): void {
  const kinds = new Map<string, CheckpointDirectoryEntry['kind']>();
  for (const entry of entries) {
    const path = safeChild(root, entry.path);
    if (kinds.has(path)) throw new Error(`checkpoint 目录项重复：${entry.path}`);
    kinds.set(path, entry.kind);
  }
  for (const [path] of kinds) {
    let parent = dirname(path);
    while (parent !== root) {
      const kind = kinds.get(parent);
      if (kind !== undefined && kind !== 'directory') {
        throw new Error(`checkpoint 目录项的父路径不是目录：${relative(root, parent)}`);
      }
      const next = dirname(parent);
      if (next === parent) throw new Error(`checkpoint 目录项逃逸：${path}`);
      parent = next;
    }
  }
}

async function validateContents(
  blobs: BlobStore,
  manifest: Manifest,
  signal?: AbortLike,
): Promise<void> {
  const refs = contentRefs(manifest);
  for (const ref of refs.values()) {
    assertActive(signal);
    const info = await blobs.stat(ref);
    if (info?.size !== ref.size) {
      throw new Error(`checkpoint 内容 blob 缺失或大小不符：${ref.hash}`);
    }
    let size = 0;
    for await (const chunk of blobs.open(ref)) {
      assertActive(signal);
      size += chunk.byteLength;
    }
    if (size !== ref.size) throw new Error(`checkpoint 内容 blob 大小不符：${ref.hash}`);
  }
}

function contentRefs(manifest: Manifest): Map<string, BlobRef> {
  const refs = new Map<string, BlobRef>();
  for (const target of manifest.targets) {
    if (target.kind === 'file') refs.set(target.content.hash, target.content);
    if (target.kind === 'directory') {
      for (const entry of target.entries) {
        if (entry.kind === 'file') refs.set(entry.content.hash, entry.content);
      }
    }
  }
  return refs;
}

async function restoreTarget(
  blobs: BlobStore,
  target: CheckpointTarget,
  signal?: AbortLike,
): Promise<void> {
  if (target.kind === 'missing') {
    await rm(target.path, { recursive: true, force: true });
    return;
  }
  if (target.kind === 'file') {
    await writeAtomic(blobs, target.path, target.content, signal);
    return;
  }

  await rm(target.path, { recursive: true, force: true });
  await mkdir(target.path, { recursive: true });
  const directories = target.entries.filter((entry) => entry.kind === 'directory');
  directories.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  for (const entry of directories) await mkdir(safeChild(target.path, entry.path), { recursive: true });
  for (const entry of target.entries) {
    assertActive(signal);
    if (entry.kind === 'file') {
      await writeAtomic(blobs, safeChild(target.path, entry.path), entry.content, signal);
    } else if (entry.kind === 'symlink') {
      const path = safeChild(target.path, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await symlink(entry.link, path);
    }
  }
}

async function writeAtomic(
  blobs: BlobStore,
  target: string,
  ref: BlobRef,
  signal?: AbortLike,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.xm-restore-${randomUUID()}`;
  const handle = await open(temporary, 'wx');
  try {
    for await (const chunk of blobs.open(ref)) {
      assertActive(signal);
      await handle.writeFile(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}

function safeChild(root: string, path: string): string {
  const child = resolve(root, path);
  const rel = relative(root, child);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`checkpoint 目录项逃逸：${path}`);
  }
  return child;
}

const overlaps = (a: string, b: string): boolean => {
  const rel = relative(a, b);
  const reverse = relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) || (!reverse.startsWith('..') && !isAbsolute(reverse));
};
const depth = (path: string): number => path.split(/[\\/]/u).length;
const assertActive = (signal?: AbortLike): void => {
  if (signal?.aborted === true) throw new Error('恢复 checkpoint 时操作已取消。');
};
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
