import type { BlobRef } from '@xm/contracts';

/**
 * Blob 存储端口（ADR-0013 不变量七 / 遗留项之一）。
 *
 * 事件流里永远只放 `BlobRef`，二进制与大文本进这里。理由在契约层已经写死
 * （`contracts/base/blob.ts`）：事件要能被反复回放、要能整批读进内存做 reduce，
 * 塞进一张截图就全毁了。
 *
 * ── 两条不变量 ──
 *
 * **一、`put()` 返回即已持久化。** 这是 ADR-0013 不变量七"blob 先于引用它的事件落盘"
 * 的执行点。顺序不能反：事件是不可变的，一条指向不存在内容的 `BlobRef` 永远修不掉，
 * 而它的表现是几个月后打开旧会话时图片裂开——那时已经查不出是哪次崩溃造成的。
 * 文件实现因此必须 写临时文件 → fsync → rename，而不是边写边返回。
 *
 * **二、内容寻址，只增不删。** `hash` 就是身份，同一张截图在会话里出现十次也只存一份。
 * 引用计数与 GC 推迟到 M2（与 checkpoint 一起做，那时才知道"还原点还需要哪些 blob"）；
 * 在那之前**不提供删除**——没有引用计数的删除只会删掉还在用的东西。
 */

/** 计算 sha256 并返回小写十六进制。内核没有 crypto，由调用方注入 */
export type Sha256Hex = (data: Uint8Array) => Promise<string>;

export interface BlobStat {
  readonly hash: string;
  readonly mime: string;
  readonly size: number;
}

export interface BlobStore {
  /**
   * 写入并返回引用。**返回时内容已经持久化**（见不变量一）。
   *
   * 同一份内容重复 put 是幂等的：返回同一个 hash，不重复占空间。
   */
  put(data: Uint8Array, mime: string, name?: string): Promise<BlobRef>;

  /**
   * 流式写入并返回引用。语义与 `put()` 相同：返回时内容已持久化，同一内容幂等。
   * 大文件 checkpoint 必须走这个入口，不能先在主进程里拼成一整块。
   */
  putStream(data: AsyncIterable<Uint8Array>, mime: string, name?: string): Promise<BlobRef>;

  /**
   * 流式读取。与 `EventStore.read()` 同样的理由：blob 可能是几十 MB 的截图或日志，
   * 一次性物化会阻塞主进程。
   *
   * @throws {BlobNotFoundError}
   * @throws {BlobIntegrityError} 读回的内容与 hash 对不上
   */
  open(ref: BlobRef): AsyncIterable<Uint8Array>;

  /** 不存在时返回 `undefined`，**不抛**——"这个引用还在不在"是个正常的问题 */
  stat(ref: BlobRef): Promise<BlobStat | undefined>;

  close(): Promise<void>;
}

export class BlobNotFoundError extends Error {
  readonly hash: string;

  constructor(hash: string) {
    super(
      `blob ${hash.slice(0, 12)}… 不存在。` +
        `事件里出现指向不存在内容的引用，通常意味着写入顺序反了（ADR-0013 不变量七）。`,
    );
    this.name = 'BlobNotFoundError';
    this.hash = hash;
  }
}

/** 读回的内容与 hash 对不上 —— 数据损坏或被外部改动过 */
export class BlobIntegrityError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `blob 内容与摘要不符：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…。` +
        `内容寻址的存储出现这种情况说明文件被外部改动或已损坏。`,
    );
    this.name = 'BlobIntegrityError';
    this.expected = expected;
    this.actual = actual;
  }
}

// ── 工具 ────────────────────────────────────────────────────────

/** 把流式读取拼成一整块。只在确定内容不大时用 —— 存在的意义是让测试与小附件好写 */
export async function readBlob(store: BlobStore, ref: BlobRef): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of store.open(ref)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const isBlobRefShape = (v: Record<string, unknown>): boolean =>
  typeof v.hash === 'string' &&
  /^[a-f0-9]{64}$/.test(v.hash) &&
  typeof v.mime === 'string' &&
  typeof v.size === 'number';

/**
 * 深度收集一个值里出现的全部 `BlobRef`。
 *
 * 用途是把不变量七变成**可断言的东西**：回放一个会话，把收集到的引用逐个 `stat()`，
 * 有一个解析不了就说明写入顺序反过。光在文档里写"先写 blob 再写事件"约束不住任何人。
 *
 * 按形状识别而不是按字段名（payload 是 `looseObject`，字段名各处不一）。
 */
export function collectBlobRefs(value: unknown, out: BlobRef[] = []): BlobRef[] {
  if (value === null || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, out);
    return out;
  }

  const record = value as Record<string, unknown>;
  if (isBlobRefShape(record)) {
    out.push(record as unknown as BlobRef);
    return out;
  }
  for (const item of Object.values(record)) collectBlobRefs(item, out);
  return out;
}
