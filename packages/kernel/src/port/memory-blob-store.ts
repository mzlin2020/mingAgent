import type { BlobRef } from '@xm/contracts';
import type { BlobStat, BlobStore, Sha256Hex } from './blob-store.js';
import { BlobIntegrityError, BlobNotFoundError } from './blob-store.js';

interface Cell {
  readonly data: Uint8Array;
  readonly mime: string;
}

/**
 * `BlobStore` 的参考实现：纯内存，零 I/O。
 *
 * 与 `MemoryEventStore` 一样不是玩具——headless 冒烟、评测回放、以及任何"需要一张图片
 * 但不该碰文件系统"的单测都用它。它也是 `FileBlobStore` 的对照物：
 * **内存过、文件不过，是文件实现的问题；两边都不过，是契约写错了。**
 *
 * sha256 由构造时注入：内核没有 crypto，也不该为了算个摘要就去依赖 `node:crypto`。
 */
export class MemoryBlobStore implements BlobStore {
  readonly #cells = new Map<string, Cell>();
  readonly #sha256: Sha256Hex;
  #closed = false;

  constructor(sha256: Sha256Hex) {
    this.#sha256 = sha256;
  }

  async put(data: Uint8Array, mime: string, name?: string): Promise<BlobRef> {
    this.#assertOpen();
    const hash = await this.#sha256(data);
    if (!this.#cells.has(hash)) {
      // 复制一份：调用方可能复用同一个 buffer，内容寻址的存储被就地改写就彻底错了
      this.#cells.set(hash, { data: Uint8Array.from(data), mime });
    }
    return { hash, mime, size: data.length, ...(name === undefined ? {} : { name }) };
  }

  async putStream(
    data: AsyncIterable<Uint8Array>,
    mime: string,
    name?: string,
  ): Promise<BlobRef> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of data) {
      chunks.push(Uint8Array.from(chunk));
      size += chunk.length;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return this.put(joined, mime, name);
  }

  async *open(ref: BlobRef): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const cell = this.#cells.get(ref.hash);
    if (cell === undefined) throw new BlobNotFoundError(ref.hash);

    const actual = await this.#sha256(cell.data);
    if (actual !== ref.hash) throw new BlobIntegrityError(ref.hash, actual);

    yield Uint8Array.from(cell.data);
  }

  stat(ref: BlobRef): Promise<BlobStat | undefined> {
    this.#assertOpen();
    const cell = this.#cells.get(ref.hash);
    return Promise.resolve(
      cell === undefined
        ? undefined
        : { hash: ref.hash, mime: cell.mime, size: cell.data.length },
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MemoryBlobStore 已关闭。');
  }
}
