import type { BlobRef } from '@xm/contracts';
import type { BlobStore } from './blob-store.js';
import { BlobNotFoundError, collectBlobRefs, readBlob } from './blob-store.js';

/**
 * `BlobStore` 端口的一致性测试套件。
 *
 * 与 `EVENT_STORE_CONTRACT` 同样的形态与同样的理由：不依赖测试框架，放在 `src/`，
 * 好让 `packages/storage` 的测试直接 import（跨包 import `.test.ts` 走不通）。
 */

export interface BlobStoreCase {
  readonly name: string;
  run(makeStore: () => BlobStore): Promise<void>;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`端口契约不满足：${msg}`);
}

/**
 * 只处理 ASCII。内核的 lib 只有 ES2023、types 是空数组，`TextEncoder` 在这里不存在
 * （加 DOM lib 会把 fetch 一起带进来，见 model-provider.ts 里同样的取舍）。
 * 多字节内容改用显式字节数组测，见"二进制内容不被当成文本破坏"那条。
 */
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array): string => String.fromCharCode(...b);

const MISSING: BlobRef = {
  hash: 'f'.repeat(64),
  mime: 'application/octet-stream',
  size: 1,
};

export const BLOB_STORE_CONTRACT: readonly BlobStoreCase[] = [
  {
    name: '写入后能原样读回',
    async run(makeStore) {
      const store = makeStore();
      const ref = await store.put(bytes('xiaoming'), 'text/plain');
      assert(text(await readBlob(store, ref)) === 'xiaoming', '读回的内容应与写入的一致');
      assert(ref.size === 8, 'size 应等于字节数');
      assert(/^[a-f0-9]{64}$/.test(ref.hash), 'hash 应为 sha256 十六进制小写');
    },
  },

  {
    name: '内容寻址：同一份内容重复写入得到同一个 hash',
    async run(makeStore) {
      const store = makeStore();
      const a = await store.put(bytes('same'), 'text/plain');
      const b = await store.put(bytes('same'), 'text/plain');
      assert(a.hash === b.hash, '相同内容必须得到相同 hash，否则去重与还原点都失效');
    },
  },

  {
    name: '不同内容得到不同 hash',
    async run(makeStore) {
      const store = makeStore();
      const a = await store.put(bytes('one'), 'text/plain');
      const b = await store.put(bytes('two'), 'text/plain');
      assert(a.hash !== b.hash, '不同内容不该撞 hash');
    },
  },

  {
    name: '空内容也是合法的 blob',
    async run(makeStore) {
      const store = makeStore();
      const ref = await store.put(new Uint8Array(0), 'application/octet-stream');
      assert(ref.size === 0, '空 blob 的 size 应为 0');
      assert((await readBlob(store, ref)).length === 0, '空 blob 应读出零字节而不是抛错');
    },
  },

  {
    name: '二进制内容不被当成文本破坏',
    async run(makeStore) {
      const store = makeStore();
      // 0x00 与 0xff 是"按文本读写"最先崩掉的两个字节；末尾三个是"小"的 UTF-8 编码
      const raw = Uint8Array.from([0, 1, 0xfe, 0xff, 0, 0x80, 0xe5, 0xb0, 0x8f]);
      const ref = await store.put(raw, 'application/octet-stream');
      const back = await readBlob(store, ref);
      assert(
        back.length === raw.length && back.every((b, i) => b === raw[i]),
        '二进制内容必须逐字节相等——编码问题在这里最容易被"看起来能用"掩盖',
      );
    },
  },

  {
    name: 'name 只是展示用，不参与寻址',
    async run(makeStore) {
      const store = makeStore();
      const a = await store.put(bytes('x'), 'text/plain', '截图1.png');
      const b = await store.put(bytes('x'), 'text/plain', '截图2.png');
      assert(a.hash === b.hash, '文件名不同不该改变内容寻址的结果');
      assert(a.name === '截图1.png', 'name 应原样带回');
    },
  },

  {
    name: 'stat 对不存在的引用返回 undefined 而不是抛错',
    async run(makeStore) {
      assert((await makeStore().stat(MISSING)) === undefined, '缺失应以 undefined 表达');
    },
  },

  {
    name: 'open 对不存在的引用抛 BlobNotFoundError',
    async run(makeStore) {
      const store = makeStore();
      try {
        await readBlob(store, MISSING);
      } catch (e) {
        assert(e instanceof BlobNotFoundError, `应抛 BlobNotFoundError，实际：${String(e)}`);
        return;
      }
      assert(false, '读取不存在的 blob 必须抛错——静默返回空内容会让坏引用一路传下去');
    },
  },

  {
    name: 'put 返回时内容已可读 —— 不变量七的执行点',
    async run(makeStore) {
      const store = makeStore();
      const ref = await store.put(bytes('screenshot'), 'image/png');
      /*
       * 这条用例看着平淡，但它锁的是 ADR-0013 不变量七：blob 必须先于引用它的事件落盘。
       * 只要 `put()` 一 resolve 内容就可读，调用方按 "先 put 再 append" 写就够了。
       * 反过来，如果实现里 put 只是排进了写队列，这条会红——而线上表现是
       * 崩溃后旧会话的图片裂开，且因为事件不可变，永远修不掉。
       */
      assert((await store.stat(ref)) !== undefined, 'put resolve 之后 stat 必须已经能查到');
      assert(text(await readBlob(store, ref)) === 'screenshot', 'put resolve 之后必须立即可读');
    },
  },

  {
    name: '会话里的全部 BlobRef 都应能解析 —— 坏引用检测',
    async run(makeStore) {
      const store = makeStore();
      const ref = await store.put(bytes('附件'), 'text/plain', 'a.txt');
      // 模拟一条事件的 payload：引用埋在嵌套结构里，靠形状而不是字段名找出来
      const payload = { blocks: [{ type: 'image', source: ref }], meta: { n: 1 } };

      const found = collectBlobRefs(payload);
      assert(found.length === 1, `应从 payload 里找出 1 个引用，实际 ${String(found.length)}`);
      for (const r of found) {
        assert((await store.stat(r)) !== undefined, '事件里的引用必须都能解析');
      }
      assert(collectBlobRefs({ blocks: [{ type: 'image', source: MISSING }] }).length === 1,
        '缺失的引用也要能被收集出来，否则检测不到坏引用');
    },
  },
];
