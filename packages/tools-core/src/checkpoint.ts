import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BlobRef } from '@xm/contracts';
import type {
  BlobStore,
  CheckpointBeforeResult,
  Checkpointer,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';

/**
 * 文件还原点的 Node 实现：把**将被改动的文件的当前内容**存进内容寻址的 blob。
 *
 * ── 判据来自这次调用的主张，不是一份名单 ──
 *
 * "哪些调用需要还原点" = **主张里带着 `fs.write` / `fs.delete` 的具体路径**（ADR-0026）。
 * 与权限判定读的是同一份东西。维护第二份名单的下场在这个仓库里已经见过一次：
 * 自改红线只挂 `self.modify`，而一个普通写文件工具声明的是 `fs.write`，
 * 于是九条红线被整体绕过（ADR-0012 复审）。
 *
 * 判据从"工具声明了什么能力"换成"这次调用主张了什么"之后白拿一样东西：
 * `shell.exec` 跑 `rm foo.txt` 也有还原点了——它主张的是 `fs.delete <绝对路径>`，
 * 与 `fs.delete` 工具主张的是同一种东西。而按能力声明判的话，
 * `shell.exec` 声明的是 `shell.exec`，一个还原点都不会建。
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
  /** 测试注入点；生产默认使用 node:fs/promises。 */
  readonly statFile?: typeof stat;
  readonly readFileBytes?: typeof readFile;
}

/** 单个文件的快照上限。超过就不快照，并在 label 里说清楚——绝不假装存过 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export const nodeCheckpointer = (options: NodeCheckpointerOptions): Checkpointer => ({
  async before(
    _tool: RegisteredTool,
    _input: unknown,
    ctx: ToolContext,
    claims: readonly PermissionClaim[],
  ): Promise<CheckpointBeforeResult | undefined> {
    if (ctx.signal.aborted) return undefined;

    const paths = [
      ...new Set(
        claims
          .filter((c) => c.capability === 'fs.write' || c.capability === 'fs.delete')
          .map((c) => c.target)
          .filter((t) => t !== ''),
      ),
    ];
    if (paths.length === 0) return undefined;

    const refs: string[] = [];
    const labels: string[] = [];
    const warnings: string[] = [];

    for (const path of paths) {
      const snapshot = await snapshotOne(
        options.blobs,
        path,
        options.statFile ?? stat,
        options.readFileBytes ?? readFile,
      );
      if (snapshot.ref === undefined) warnings.push(snapshot.label);
      else {
        refs.push(snapshot.ref);
        labels.push(snapshot.label);
      }
    }

    return {
      ...(refs.length === 0
        ? {}
        : { record: { kind: 'fs' as const, ref: refs.join(','), label: labels.join('；') } }),
      warnings,
    };
  },
});

interface OneSnapshot {
  readonly ref?: string;
  readonly label: string;
}

async function snapshotOne(
  blobs: BlobStore,
  path: string,
  statFile: typeof stat,
  readFileBytes: typeof readFile,
): Promise<OneSnapshot> {
  /*
   * 目录快照做不了，**而且要说出来**。
   *
   * `rm -rf dir` 是经由 `shell.exec` 最容易发生的破坏，偏偏也是这里覆盖不了的一种：
   * 存一棵目录树需要打包与 GC，那是 M2 的事。宁可让用户看到"这一步没有还原点"，
   * 也不要让还原点列表里出现一条指向空内容、回退时什么也恢复不了的记录。
   */
  try {
    const info = await statFile(path);
    if (info.isDirectory()) {
      return { label: `${path}（目录，**这一步没有还原点**，ADR-0026 遗留）` };
    }
  } catch (e) {
    if (!isNotFound(e)) throw e;
    const ref = await blobs.put(new Uint8Array(0), 'application/octet-stream', basename(path));
    return { ref: refString(ref), label: `${path}（原本不存在）` };
  }

  const data = await readFileBytes(path);

  if (data.byteLength > MAX_SNAPSHOT_BYTES) {
    /*
     * 太大就不存，**并且说出来**。
     *
     * 存一份 8 MB 以上的快照本身不难，难的是它会让 blob 目录随着几次大文件改动
     * 迅速膨胀，而 GC 要等 M2。宁可让这一次没有退路且用户知道，
     * 也不要悄悄存下去直到磁盘满。
     */
    return {
      label: `${path}（${String(data.byteLength)} 字节，超过快照上限，**这一步没有还原点**）`,
    };
  }

  const ref = await blobs.put(data, 'application/octet-stream', basename(path));
  return { ref: refString(ref), label: `${path}（${String(data.byteLength)} 字节）` };
}

/** `sha256:<hex>:<size>` —— 事件里的 `ref` 是字符串，要能一眼看出指向哪个 blob */
const refString = (ref: BlobRef): string => `sha256:${ref.hash}:${String(ref.size)}`;

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

