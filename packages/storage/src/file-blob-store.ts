import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BlobRef } from '@xm/contracts';
import type { BlobStat, BlobStore } from '@xm/kernel';
import { BlobIntegrityError, BlobNotFoundError } from '@xm/kernel';

/**
 * `BlobStore` 的文件落地：内容寻址，两级分片。
 *
 * ```
 * <root>/ab/cdef...            内容（无扩展名，扩展名会诱使人按名字猜类型）
 * <root>/.tmp/<uuid>           写入中的临时文件
 * ```
 *
 * 两级分片是为了别让一个目录里堆几万个文件——那会让 `ls` 卡住、让某些文件系统变慢，
 * 而这类问题只有在用了一年之后才出现。
 */
export class FileBlobStore implements BlobStore {
  readonly #root: string;
  #closed = false;

  private constructor(root: string) {
    this.#root = root;
  }

  static async open(root: string): Promise<FileBlobStore> {
    await mkdir(join(root, '.tmp'), { recursive: true });
    return new FileBlobStore(root);
  }

  /**
   * 写临时文件 → fsync → rename。**这三步就是 ADR-0013 不变量七的执行点。**
   *
   * 顺序不能省：`rename` 在同一个文件系统内是原子的，所以读者要么看不到这个 blob，
   * 要么看到的是完整内容——不存在"看到一个半截文件"的中间态。少了 fsync，
   * 断电后可能留下一个大小对、内容是空洞的文件，而它的名字（hash）还在向所有人保证
   * 内容是对的。事件不可变，这种坏引用永远修不掉。
   */
  async put(data: Uint8Array, mime: string, name?: string): Promise<BlobRef> {
    this.#assertOpen();
    const hash = createHash('sha256').update(data).digest('hex');
    const target = this.#pathOf(hash);
    const ref: BlobRef = { hash, mime, size: data.length, ...(name === undefined ? {} : { name }) };

    // 内容寻址：同一份内容重复 put 是幂等的，直接认领已有文件
    if (await exists(target)) return ref;

    const tmp = join(this.#root, '.tmp', randomUUID());
    const fh = await open(tmp, 'wx');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }

    await mkdir(dirname(target), { recursive: true });
    await rename(tmp, target);
    await fsyncDir(dirname(target));

    return ref;
  }

  /**
   * 流式读取，**边读边校验**。
   *
   * 摘要只有读完才能确定，所以 `BlobIntegrityError` 是在流结束时抛的——也就是说
   * 消费方可能已经拿到了若干块损坏数据。这是个真实的取舍：另一条路是先整块读进内存
   * 校验完再吐，那就丧失了流式的全部意义（几十 MB 的截图）。
   *
   * 需要"用之前先确认完好"的调用方请用 `readBlob()`：它本来就把整块读完才返回。
   */
  async *open(ref: BlobRef): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const target = this.#pathOf(ref.hash);
    if (!(await exists(target))) throw new BlobNotFoundError(ref.hash);

    const digest = createHash('sha256');
    for await (const chunk of createReadStream(target)) {
      const bytes = chunk as Uint8Array;
      digest.update(bytes);
      yield bytes;
    }

    const actual = digest.digest('hex');
    if (actual !== ref.hash) throw new BlobIntegrityError(ref.hash, actual);
  }

  async stat(ref: BlobRef): Promise<BlobStat | undefined> {
    this.#assertOpen();
    try {
      const s = await stat(this.#pathOf(ref.hash));
      return { hash: ref.hash, mime: ref.mime, size: s.size };
    } catch {
      return undefined;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  #pathOf(hash: string): string {
    return join(this.#root, hash.slice(0, 2), hash.slice(2));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('FileBlobStore 已关闭。');
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * 把目录项本身刷下去。文件内容 fsync 过了，但"这个文件名存在"这件事在目录里，
 * 不刷目录的话断电后可能出现"文件没了、内容还在磁盘上无人认领"。
 *
 * Windows 上目录打不开来 fsync，忽略即可——NTFS 的元数据日志本来就保证了这一点。
 */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // 见上：平台不支持时这不是错误
  }
}
