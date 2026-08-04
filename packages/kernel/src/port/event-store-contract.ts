import type { PersistedEvent, SessionId, XmEventType } from '@xm/contracts';
import { createEvent, newSessionId } from '@xm/contracts';
import type { EventStore, SealedEvent } from './event-store.js';
import { SeqConflictError, WriteLeaseError, sealEvent } from './event-store.js';

/**
 * 事件存储端口的**一致性测试套件**。
 *
 * 端口只有类型，而类型管不住"append 到底原不原子"这类事情。所以端口的真正内容是这一组
 * 用例：任何 `EventStore` 实现——内存的、SQLite 的、将来别的——都必须全部通过才算实现了它。
 *
 * 刻意不依赖任何测试框架（不 import vitest），因为它要被 `packages/storage` 的测试复用，
 * 而跨包 import 一个 `.test.ts` 是走不通的。每条用例就是一个抛异常表示失败的 async 函数，
 * 外层用 vitest 包一层即可（见 `tests/event-store.test.ts`）。
 *
 * 这么做是有前科的：ADR-0012 ⑧ 记下过三个"文档里存在、代码里不存在"的扩展点。
 * 一个只写在 ADR 里的端口契约，和那三个是同一种东西。
 */

export interface EventStoreCase {
  readonly name: string;
  run(makeStore: () => EventStore): Promise<void>;
}

/** 写成函数声明而不是箭头函数：断言签名 `asserts cond` 只在函数声明上生效 */
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`端口契约不满足：${msg}`);
}

const rejects = async (
  fn: () => Promise<unknown>,
  pred: (e: unknown) => boolean,
  msg: string,
): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    assert(pred(e), `${msg}（实际抛出：${String(e)}）`);
    return;
  }
  assert(false, `${msg}（实际没有抛出）`);
};

// ── 造事件 ──────────────────────────────────────────────────────

let clock = 1_700_000_000_000;

const mk = (
  sessionId: SessionId,
  seq: number,
  type: XmEventType,
  payload: unknown,
): SealedEvent =>
  sealEvent(
    createEvent({
      type,
      sessionId,
      seq,
      ts: (clock += 1000),
      payload: payload as never,
    }) as PersistedEvent,
  );

const created = (s: SessionId, title?: string): SealedEvent =>
  mk(s, 1, 'session.created', {
    cwd: '/w',
    modelRef: 'anthropic/claude-opus-5',
    ...(title === undefined ? {} : { title }),
  });

const notice = (s: SessionId, seq: number): SealedEvent =>
  mk(s, seq, 'notice.posted', { level: 'info', code: 'x', message: `#${String(seq)}` });

const drain = async (it: AsyncIterable<PersistedEvent>): Promise<PersistedEvent[]> => {
  const out: PersistedEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

// ── 用例 ────────────────────────────────────────────────────────

export const EVENT_STORE_CONTRACT: readonly EventStoreCase[] = [
  {
    name: '空库没有会话',
    async run(makeStore) {
      assert((await makeStore().listSessions()).length === 0, '新库的 listSessions 应为空');
    },
  },

  {
    name: '不存在的会话读出空序列，而不是抛错',
    async run(makeStore) {
      assert((await drain(makeStore().read(newSessionId()))).length === 0, '应产出空序列');
    },
  },

  {
    name: '首条事件必须是 session.created',
    async run(makeStore) {
      const s = newSessionId();
      const w = await makeStore().openForWrite(s);
      await rejects(
        () => w.append([notice(s, 1)]),
        (e) => e instanceof Error,
        '首条不是 session.created 时应拒绝',
      );
    },
  },

  {
    name: '追加后能原样读回，顺序与内容不变',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      const batch = [created(s), notice(s, 2), notice(s, 3)];
      await w.append(batch);

      const back = await drain(store.read(s));
      assert(back.length === 3, `应读回 3 条，实际 ${String(back.length)}`);
      assert(
        back.map((e) => e.seq).join(',') === '1,2,3',
        `seq 顺序应为 1,2,3，实际 ${back.map((e) => e.seq).join(',')}`,
      );
      assert(JSON.stringify(back) === JSON.stringify(batch), '读回的内容应与写入完全一致');
      assert(w.lastSeq === 3, `lastSeq 应推进到 3，实际 ${String(w.lastSeq)}`);
    },
  },

  {
    name: 'fromSeq / toSeq 是闭区间',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await w.append([created(s), notice(s, 2), notice(s, 3), notice(s, 4)]);

      const mid = await drain(store.read(s, { fromSeq: 2, toSeq: 3 }));
      assert(mid.map((e) => e.seq).join(',') === '2,3', 'fromSeq/toSeq 两端都应包含');

      const tail = await drain(store.read(s, { fromSeq: 3 }));
      assert(tail.map((e) => e.seq).join(',') === '3,4', '省略 toSeq 应读到末尾');
    },
  },

  {
    name: 'seq 出现空洞即抛 SeqConflictError，且整批不落（原子性）',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await w.append([created(s)]);

      await rejects(
        () => w.append([notice(s, 2), notice(s, 4)]),
        (e) => e instanceof SeqConflictError,
        '空洞应抛 SeqConflictError',
      );
      const back = await drain(store.read(s));
      assert(
        back.length === 1,
        `失败的批次一条都不该落库，实际库里有 ${String(back.length)} 条——` +
          `这正是"半批写入"的样子：seq=2 落了，回放出的状态永远少一段`,
      );
      assert(w.lastSeq === 1, 'lastSeq 不应因失败的批次而推进');
    },
  },

  {
    name: 'seq 重复即抛 —— 那意味着有第二个写者',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await w.append([created(s), notice(s, 2)]);
      await rejects(
        () => w.append([notice(s, 2)]),
        (e) => e instanceof SeqConflictError,
        '重复 seq 应抛 SeqConflictError',
      );
    },
  },

  {
    name: '同一会话不能有第二个写者；close 之后可以重新取得',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await rejects(
        () => store.openForWrite(s),
        (e) => e instanceof WriteLeaseError,
        '第二次 openForWrite 应被拒',
      );
      await w.close();
      const w2 = await store.openForWrite(s);
      assert(w2.sessionId === s, 'close 之后应能重新取得写句柄');
      await rejects(
        () => w.append([created(s)]),
        (e) => e instanceof WriteLeaseError,
        '已关闭的旧句柄不得再写',
      );
    },
  },

  {
    name: '摘要投影：标题、时间与 lastSeq 随事件推进',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await w.append([created(s, '初始标题')]);

      const one = (await store.listSessions())[0];
      assert(one?.title === '初始标题', 'session.created 的 title 应进摘要');
      assert(one.lastSeq === 1, 'lastSeq 应为 1');
      assert(one.createdAt > 0, 'createdAt 应由 session.created 落定');

      await w.append([mk(s, 2, 'session.renamed', { title: '改过的标题' })]);
      const two = (await store.listSessions())[0];
      assert(two?.title === '改过的标题', 'session.renamed 应更新摘要标题');
      assert(two.updatedAt > two.createdAt, 'updatedAt 应随新事件推进');
      assert(two.createdAt === one.createdAt, 'createdAt 不应被后续事件改动');
    },
  },

  {
    name: 'rebuildSummaries 与增量投影等价 —— 投影坏了能从事件流修回来',
    async run(makeStore) {
      const store = makeStore();
      const s = newSessionId();
      const w = await store.openForWrite(s);
      await w.append([created(s, 'A'), mk(s, 2, 'session.renamed', { title: 'B' }), notice(s, 3)]);

      const before = await store.listSessions();
      await store.rebuildSummaries();
      const after = await store.listSessions();
      assert(
        JSON.stringify(before) === JSON.stringify(after),
        '重建出的摘要必须与增量维护的完全一致，否则两条路径已经分叉',
      );
    },
  },

  {
    name: 'listSessions 按 updatedAt 倒序',
    async run(makeStore) {
      const store = makeStore();
      const a = newSessionId();
      const b = newSessionId();
      const wa = await store.openForWrite(a);
      await wa.append([created(a, 'A')]);
      const wb = await store.openForWrite(b);
      await wb.append([created(b, 'B')]);
      await wa.append([notice(a, 2)]);

      const list = await store.listSessions();
      assert(list[0]?.sessionId === a, '最近有事件的会话应排在最前');
    },
  },
];
