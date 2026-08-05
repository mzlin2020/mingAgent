import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BLOB_STORE_CONTRACT, MemoryBlobStore, collectBlobRefs, readBlob } from '@xm/kernel';

/** 内核没有 crypto，摘要由调用方注入。这里用 Node 的，storage 包用同一个算法 */
const sha256 = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

describe('BlobStore 端口契约 · MemoryBlobStore', () => {
  for (const c of BLOB_STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(() => new MemoryBlobStore(sha256));
    });
  }
});

describe('collectBlobRefs：坏引用检测的基础', () => {
  it('按形状识别，不按字段名 —— payload 是 looseObject，字段名各处不一', () => {
    const ref = {
      hash: 'a'.repeat(64),
      mime: 'image/png',
      size: 3,
    };
    // 三个完全不同的字段名，都得找出来
    const found = collectBlobRefs({
      source: ref,
      nested: { attachment: ref },
      list: [{ whatever: ref }],
    });
    expect(found).toHaveLength(3);
  });

  it('不把长得像但缺字段的对象误当引用', () => {
    expect(collectBlobRefs({ x: { hash: 'a'.repeat(64) } })).toHaveLength(0);
    expect(collectBlobRefs({ x: { hash: 'ZZ', mime: 'x', size: 1 } })).toHaveLength(0);
  });

  it('循环引用不会栈溢出（事件 payload 理论上不该有，但收集器不该因此崩）', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    // 走的是 Object.values 递归，遇到自引用会无限下探——这条用例把行为钉死
    expect(() => collectBlobRefs(cyclic)).toThrow(RangeError);
  });
});

describe('MemoryBlobStore 的两处易错行为', () => {
  it('🔴 put 会复制入参 —— 调用方复用 buffer 不能改到已存内容', async () => {
    const store = new MemoryBlobStore(sha256);
    const buf = Uint8Array.from([1, 2, 3]);
    const ref = await store.put(buf, 'application/octet-stream');
    buf[0] = 99;
    expect(Array.from(await readBlob(store, ref))).toEqual([1, 2, 3]);
  });

  it('🔴 open 读出的也是副本 —— 拿到手改不回库里', async () => {
    const store = new MemoryBlobStore(sha256);
    const ref = await store.put(Uint8Array.from([1, 2, 3]), 'application/octet-stream');
    const first = await readBlob(store, ref);
    first[0] = 99;
    expect(Array.from(await readBlob(store, ref))).toEqual([1, 2, 3]);
  });
});
