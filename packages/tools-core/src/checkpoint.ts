import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BlobRef } from '@xm/contracts';
import type {
  BlobStore,
  CheckpointRecord,
  Checkpointer,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';

/**
 * 文件还原点的 Node 实现：把**将被改动的文件的当前内容**存进内容寻址的 blob。
 *
 * ── 判据来自工具的自描述，不是一份名单 ──
 *
 * "哪些调用需要还原点" = 声明了 `fs.write` / `fs.delete` 且声明了 `pathInputs` 的调用。
 * 与权限判定读的是同一份声明。维护第二份名单的下场在这个仓库里已经见过一次：
 * 自改红线只挂 `self.modify`，而一个普通写文件工具声明的是 `fs.write`，
 * 于是九条红线被整体绕过（ADR-0012 复审）。
 *
 * ── 只存"改之前"，不存"改之后" ──
 *
 * 改之后的内容在文件里就有，不需要第二份。而且内容寻址让重复内容不重复占空间：
 * 同一个文件被改十次，十份快照里相同的那几份只落一次盘。
 *
 * ── 新建文件也要留痕 ──
 *
 * 写一个还不存在的文件时没有内容可存，但**"这个文件原本不存在"本身就是还原信息**——
 * 回退等于删掉它。这里用一个空内容的 blob 加上 label 里的说明来表达，
 * 而不是干脆不记：不记的话，回退时无从知道该删还是该恢复。
 */

export interface NodeCheckpointerOptions {
  readonly blobs: BlobStore;
}

/** 单个文件的快照上限。超过就不快照，并在 label 里说清楚——绝不假装存过 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export const nodeCheckpointer = (options: NodeCheckpointerOptions): Checkpointer => ({
  async before(
    tool: RegisteredTool,
    input: unknown,
    ctx: ToolContext,
  ): Promise<CheckpointRecord | undefined> {
    const destructive = tool.descriptor.capabilities.some(
      (c) => c === 'fs.write' || c === 'fs.delete',
    );
    if (!destructive || tool.pathInputs.length === 0) return undefined;
    if (ctx.signal.aborted) return undefined;

    const paths = pathsOf(input, tool.pathInputs);
    if (paths.length === 0) return undefined;

    const refs: string[] = [];
    const labels: string[] = [];

    for (const path of paths) {
      const snapshot = await snapshotOne(options.blobs, path);
      refs.push(snapshot.ref);
      labels.push(snapshot.label);
    }

    return { kind: 'fs', ref: refs.join(','), label: labels.join('；') };
  },
});

interface OneSnapshot {
  readonly ref: string;
  readonly label: string;
}

async function snapshotOne(blobs: BlobStore, path: string): Promise<OneSnapshot> {
  let data: Uint8Array | undefined;
  try {
    data = await readFile(path);
  } catch {
    // 文件不存在（或读不到）：回退动作是"删掉它"，而这条信息全在 label 里
    data = undefined;
  }

  if (data === undefined) {
    const ref = await blobs.put(new Uint8Array(0), 'application/octet-stream', basename(path));
    return { ref: refString(ref), label: `${path}（原本不存在）` };
  }

  if (data.byteLength > MAX_SNAPSHOT_BYTES) {
    /*
     * 太大就不存，**并且说出来**。
     *
     * 存一份 8 MB 以上的快照本身不难，难的是它会让 blob 目录随着几次大文件改动
     * 迅速膨胀，而 GC 要等 M2。宁可让这一次没有退路且用户知道，
     * 也不要悄悄存下去直到磁盘满。
     */
    return {
      ref: '',
      label: `${path}（${String(data.byteLength)} 字节，超过快照上限，**这一步没有还原点**）`,
    };
  }

  const ref = await blobs.put(data, 'application/octet-stream', basename(path));
  return { ref: refString(ref), label: `${path}（${String(data.byteLength)} 字节）` };
}

/** `sha256:<hex>:<size>` —— 事件里的 `ref` 是字符串，要能一眼看出指向哪个 blob */
const refString = (ref: BlobRef): string => `sha256:${ref.hash}:${String(ref.size)}`;

function pathsOf(input: unknown, fields: readonly string[]): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const record = input as Record<string, unknown>;
  return fields
    .map((f) => record[f])
    .filter((v): v is string => typeof v === 'string' && v !== '');
}
