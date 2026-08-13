import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BlobStore } from '@xm/kernel';
import { BLOB_STORE_CONTRACT, BlobIntegrityError, readBlob } from '@xm/kernel';
import { FileBlobStore } from '@xm/storage';

const ROOT = mkdtempSync(join(tmpdir(), 'xm-blob-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let n = 0;
const tmpRoot = (): string => join(ROOT, `b${String(n++)}`);

/**
 * 契约用例是同步构造 store 的（`() => BlobStore`），而 `FileBlobStore.open()` 要 mkdir。
 * 用一个"先返回壳子、内部排队"的代理把两者接上，比为了测试改端口签名划算——
 * 端口签名要服务于运行时，不是服务于测试。
 */
const lazyStore = (root: string): BlobStore => {
  const ready = FileBlobStore.open(root);
  return {
    async put(data, mime, name) {
      return (await ready).put(data, mime, name);
    },
    async putStream(data, mime, name) {
      return (await ready).putStream(data, mime, name);
    },
    async *open(ref) {
      yield* (await ready).open(ref);
    },
    async stat(ref) {
      return (await ready).stat(ref);
    },
    async close() {
      await (await ready).close();
    },
  };
};

describe('BlobStore 端口契约 · FileBlobStore', () => {
  for (const c of BLOB_STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(() => lazyStore(tmpRoot()));
    });
  }
});

describe('FileBlobStore 专属行为', () => {
  it('两级分片：不把几万个文件堆进一个目录', async () => {
    const root = tmpRoot();
    const store = await FileBlobStore.open(root);
    const ref = await store.put(Uint8Array.from([1, 2, 3]), 'application/octet-stream');

    const shard = ref.hash.slice(0, 2);
    expect(readdirSync(root)).toContain(shard);
    expect(readdirSync(join(root, shard))).toEqual([ref.hash.slice(2)]);
    await store.close();
  });

  it('put 之后临时目录是干净的 —— 没留下半截文件', async () => {
    const root = tmpRoot();
    const store = await FileBlobStore.open(root);
    await store.put(Uint8Array.from([9, 9, 9]), 'application/octet-stream');
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
    await store.close();
  });

  it('重开 store 仍能读到之前写的内容', async () => {
    const root = tmpRoot();
    const first = await FileBlobStore.open(root);
    const ref = await first.put(Uint8Array.from([7, 7]), 'application/octet-stream');
    await first.close();

    const second = await FileBlobStore.open(root);
    expect(Array.from(await readBlob(second, ref))).toEqual([7, 7]);
    await second.close();
  });

  /**
   * 内容被外部改动。内容寻址的存储里这等于"文件在、但它已经不是它自称的东西了"，
   * 静默返回损坏数据会让坏内容一路进模型上下文。
   */
  it('🔴 文件被外部改写 → BlobIntegrityError', async () => {
    const root = tmpRoot();
    const store = await FileBlobStore.open(root);
    const ref = await store.put(Uint8Array.from([1, 2, 3]), 'application/octet-stream');

    writeFileSync(join(root, ref.hash.slice(0, 2), ref.hash.slice(2)), Buffer.from([4, 5, 6]));
    await expect(readBlob(store, ref)).rejects.toBeInstanceOf(BlobIntegrityError);
    await store.close();
  });

  it('重复 put 会修复同路径下已损坏的 blob', async () => {
    const root = tmpRoot();
    const store = await FileBlobStore.open(root);
    const bytes = Uint8Array.from([1, 2, 3]);
    const ref = await store.put(bytes, 'application/octet-stream');
    writeFileSync(join(root, ref.hash.slice(0, 2), ref.hash.slice(2)), Buffer.from([4, 5, 6]));

    expect(await store.put(bytes, 'application/octet-stream')).toEqual(ref);
    expect(Array.from(await readBlob(store, ref))).toEqual([1, 2, 3]);
    await store.close();
  });

  it('大内容分多块吐出来，不是一次性物化', async () => {
    const root = tmpRoot();
    const store = await FileBlobStore.open(root);
    const big = new Uint8Array(300_000).fill(3);
    const ref = await store.put(big, 'application/octet-stream');

    let chunks = 0;
    let total = 0;
    for await (const c of store.open(ref)) {
      chunks++;
      total += c.length;
    }
    expect(total).toBe(big.length);
    expect(chunks).toBeGreaterThan(1);
    await store.close();
  });
});
