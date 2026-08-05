import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EventStore, SealedEvent } from '@xm/kernel';
import {
  EVENT_STORE_CONTRACT,
  SeqConflictError,
  StoreVersionError,
  WriteLeaseError,
  sealEvent,
} from '@xm/kernel';
import type { SessionId } from '@xm/contracts';
import { createEvent, newSessionId } from '@xm/contracts';
import { SqliteEventStore } from '@xm/storage';

const ROOT = mkdtempSync(join(tmpdir(), 'xm-store-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let n = 0;
const tmpDbPath = (): string => join(ROOT, `s${String(n++)}.db`);

/**
 * 契约跑**两个工厂**。
 *
 * `:memory:` 快，适合跑主体逻辑；但内存库是**连接私有**的——跨连接的排他标记、WAL
 * 的读写行为在它上面根本测不到。只跑内存库，等于漏掉不变量四整条。
 * 所以文件库那一轮不是"顺手也跑一下"，它是这组测试里唯一能覆盖持久化行为的那一轮。
 */
const FACTORIES: readonly [string, () => EventStore][] = [
  [':memory:', () => new SqliteEventStore({ path: ':memory:' })],
  ['文件库', () => new SqliteEventStore({ path: tmpDbPath() })],
];

for (const [label, makeStore] of FACTORIES) {
  describe(`EventStore 端口契约 · SqliteEventStore（${label}）`, () => {
    for (const c of EVENT_STORE_CONTRACT) {
      it(c.name, async () => {
        await c.run(makeStore);
      });
    }
  });
}

// ── SQLite 专属 ──────────────────────────────────────────────────

let clock = 1_700_000_000_000;

const mk = (s: SessionId, seq: number, type: 'session.created' | 'notice.posted'): SealedEvent =>
  sealEvent(
    createEvent({
      type,
      sessionId: s,
      seq,
      ts: (clock += 1000),
      payload: (type === 'session.created'
        ? { cwd: '/w', modelRef: 'anthropic/claude-opus-5', title: 'T' }
        : { level: 'info', code: 'x', message: `#${String(seq)}` }) as never,
    }),
  );

describe('SqliteEventStore 专属行为', () => {
  it('🔴 库的 schema 版本高于本机 → 拒绝打开，不做降级解释', async () => {
    const path = tmpDbPath();
    const store = new SqliteEventStore({ path });
    await store.close();

    // 模拟"这个库由更新版本的小明创建"
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path);
    raw.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    raw.close();

    expect(() => new SqliteEventStore({ path })).toThrow(StoreVersionError);
  });

  it('🔴 第二个连接拿不到写句柄 —— 这条只有文件库测得到', async () => {
    const path = tmpDbPath();
    const a = new SqliteEventStore({ path });
    const s = newSessionId();
    const wa = await a.openForWrite(s);

    const b = new SqliteEventStore({ path });
    await expect(b.openForWrite(s)).rejects.toBeInstanceOf(WriteLeaseError);

    await wa.close();
    // 释放之后第二个连接就能接手了
    const wb = await b.openForWrite(s);
    expect(wb.sessionId).toBe(s);

    await a.close();
    await b.close();
  });

  it('🔴 事务中途失败：整批不落，last_seq 不推进，摘要不动', async () => {
    const path = tmpDbPath();
    const store = new SqliteEventStore({ path });
    const s = newSessionId();
    const w = await store.openForWrite(s);
    await w.append([mk(s, 1, 'session.created')]);

    const before = (await store.listSessions())[0];

    // 第二条 seq 跳号：校验在插入之前跑，但第一条已经进了同一个事务
    await expect(w.append([mk(s, 2, 'notice.posted'), mk(s, 9, 'notice.posted')])).rejects
      .toBeInstanceOf(SeqConflictError);

    const events = [];
    for await (const e of store.read(s)) events.push(e);
    expect(events).toHaveLength(1);
    expect(w.lastSeq).toBe(1);
    expect((await store.listSessions())[0]).toEqual(before);

    // 换个连接重新打开，确认落盘的也是同一份
    await store.close();
    const again = new SqliteEventStore({ path });
    const back = [];
    for await (const e of again.read(s)) back.push(e);
    expect(back).toHaveLength(1);
    await again.close();
  });

  /**
   * 这条是**为事务本身**写的。
   *
   * 上一条（seq 跳号）其实证明不了事务在干活：校验跑在任何一次插入之前，
   * 所以即便把 `db.transaction(...)` 整个摘掉，那条用例照样绿——2026-08-05 的反向演练
   * 当场演示了这一点。"用例是绿的"和"事务在起作用"是两件事。
   *
   * 真正需要事务的是**校验通过、插入中途失败**：这里先把库弄成"投影落后于事件"的样子
   * （events 里有 seq=3，sessions.last_seq 却是 1——正是 rebuildSummaries 存在的理由），
   * 于是 seq=2 插得进去、seq=3 撞主键。没有事务，seq=2 就永久留下了，
   * 而那恰恰是不变量一要防的半批写入。
   */
  it('🔴 校验通过但插入中途失败 → 整批回滚（这条摘掉事务就会红）', async () => {
    const path = tmpDbPath();
    const s = newSessionId();
    const store = new SqliteEventStore({ path });
    const w = await store.openForWrite(s);
    await w.append([mk(s, 1, 'session.created'), mk(s, 2, 'notice.posted'), mk(s, 3, 'notice.posted')]);
    await w.close();
    await store.close();

    // 制造"投影落后 + 事件有洞"的库：删掉 seq=2，把 last_seq 拨回 1
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path);
    raw.prepare(`DELETE FROM events WHERE session_id = ? AND seq = 2`).run(s);
    raw.prepare(`UPDATE sessions SET last_seq = 1 WHERE id = ?`).run(s);
    raw.close();

    const store2 = new SqliteEventStore({ path });
    const w2 = await store2.openForWrite(s);
    // 校验：期望 2、3，两条都对得上 —— 插入到 seq=3 时才撞上已存在的行
    await expect(
      w2.append([mk(s, 2, 'notice.posted'), mk(s, 3, 'notice.posted')]),
    ).rejects.toThrow();

    const seqs: number[] = [];
    for await (const e of store2.read(s)) seqs.push(e.seq);
    expect(seqs, 'seq=2 不该留下 —— 那就是半批写入').toEqual([1, 3]);
    await store2.close();
  });

  it('重开进程也能读回：事件与摘要都在盘上', async () => {
    const path = tmpDbPath();
    const s = newSessionId();
    {
      const store = new SqliteEventStore({ path });
      const w = await store.openForWrite(s);
      await w.append([mk(s, 1, 'session.created'), mk(s, 2, 'notice.posted')]);
      await w.close();
      await store.close();
    }
    const store = new SqliteEventStore({ path });
    const list = await store.listSessions();
    expect(list[0]?.lastSeq).toBe(2);
    expect(list[0]?.title).toBe('T');

    const seqs = [];
    for await (const e of store.read(s)) seqs.push(e.seq);
    expect(seqs).toEqual([1, 2]);
    await store.close();
  });

  it('🔴 摘要投影坏掉之后能从事件流修回来', async () => {
    const path = tmpDbPath();
    const s = newSessionId();
    const store = new SqliteEventStore({ path });
    const w = await store.openForWrite(s);
    await w.append([mk(s, 1, 'session.created'), mk(s, 2, 'notice.posted')]);
    const good = await store.listSessions();
    await w.close();
    await store.close();

    // 人为把投影改错：标题没了、lastSeq 归零
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path);
    raw.prepare(`UPDATE sessions SET title = NULL, last_seq = 0, updated_at = 0`).run();
    raw.close();

    const store2 = new SqliteEventStore({ path });
    expect((await store2.listSessions())[0]?.title).toBeUndefined();
    await store2.rebuildSummaries();
    expect(await store2.listSessions()).toEqual(good);
    await store2.close();
  });

  it('分页读取跨页仍然连续 —— 页大小是 500', async () => {
    const store = new SqliteEventStore({ path: ':memory:' });
    const s = newSessionId();
    const w = await store.openForWrite(s);
    const batch: SealedEvent[] = [mk(s, 1, 'session.created')];
    for (let i = 2; i <= 1201; i++) batch.push(mk(s, i, 'notice.posted'));
    await w.append(batch);

    const seqs: number[] = [];
    for await (const e of store.read(s)) seqs.push(e.seq);
    expect(seqs).toHaveLength(1201);
    expect(seqs[0]).toBe(1);
    expect(seqs[1200]).toBe(1201);
    // 分页边界上不重不漏
    expect(new Set(seqs).size).toBe(1201);
    await store.close();
  });

  it('回放中途写入不会撞上"连接忙" —— 分页而不是游标的理由', async () => {
    const store = new SqliteEventStore({ path: tmpDbPath() });
    const s = newSessionId();
    const w = await store.openForWrite(s);
    await w.append([mk(s, 1, 'session.created'), mk(s, 2, 'notice.posted')]);

    const seen: number[] = [];
    for await (const e of store.read(s)) {
      seen.push(e.seq);
      // 正是"UI 一边回放、一边有新事件进来"的形状
      if (e.seq === 1) await w.append([mk(s, w.lastSeq + 1, 'notice.posted')]);
    }
    expect(seen[0]).toBe(1);
    await store.close();
  });
});
