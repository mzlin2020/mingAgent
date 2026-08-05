import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db, Statement } from 'better-sqlite3';
import type { PersistedEvent, SessionId } from '@xm/contracts';
import { isCoreEvent, isPersistedEvent, parseStoredEvent } from '@xm/contracts';
import type {
  EventStore,
  ReadOptions,
  SealedEvent,
  SessionSummary,
  SessionWriter,
} from '@xm/kernel';
import { SeqConflictError, WriteLeaseError, applyToSummary, initialSummary } from '@xm/kernel';
import { migrate } from './schema.js';

/**
 * `EventStore` 的 SQLite 落地（ADR-0013）。
 *
 * 它必须通过内核里那 11 条 `EVENT_STORE_CONTRACT`——而且要在**文件库**上通过，
 * 不只是 `:memory:`。内存库是连接私有的，跨连接的排他标记在它上面根本测不到。
 *
 * 与 `MemoryEventStore` 的关系是对照物：**内存过、SQLite 不过，是 SQLite 的问题；
 * 两边都不过，是契约写错了。**
 */

/**
 * 进程级实例标识。**不是每个 store 一个**——它要能回答"这条租约是不是本进程留下的"，
 * 而同一个进程里开两个 store 是完全可能的。
 */
const PROCESS_INSTANCE_ID = randomUUID();

/**
 * 本进程当前持有活写句柄的 `${库}::${会话}`。
 *
 * **必须是进程级的，不能挂在 store 实例上。** 挂在实例上曾经漏掉一整类情况：
 * 同一个进程里开两个 `SqliteEventStore` 指向同一个文件时，第二个看到租约行的
 * `instance_id` 与自己相同（同进程），却在自己的集合里找不到句柄，于是把它当成
 * "上次崩溃的残留"接管了——两个写者，租约形同虚设。
 *
 * 这条是被 `第二个连接拿不到写句柄` 那个用例当场抓出来的，而它之所以能抓到，
 * 是因为契约在**文件库**上也跑了一遍：`:memory:` 上两个 store 本来就是两个库，
 * 这个洞在内存库工厂下永远不会暴露。
 */
const PROCESS_HANDLES = new Set<string>();

/** 分页读取的页大小。见 `read()` 里为什么不用游标 */
const READ_PAGE = 500;

export interface SqliteEventStoreOptions {
  /** 文件路径，或 `':memory:'` */
  readonly path: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  parent_session_id: string | null;
  created_at: number;
  updated_at: number;
  last_seq: number;
}

interface EventRow {
  session_id: string;
  seq: number;
  id: string;
  type: string;
  ts: number;
  turn_id: string | null;
  v: number;
  payload_json: string;
}

interface LeaseRow {
  session_id: string;
  pid: number;
  instance_id: string;
  acquired_at: number;
}

interface Statements {
  readonly selectSession: Statement;
  readonly upsertSession: Statement;
  readonly insertEvent: Statement;
  readonly selectPage: Statement;
  readonly listSessions: Statement;
  readonly selectLease: Statement;
  readonly putLease: Statement;
  readonly dropLease: Statement;
}

export class SqliteEventStore implements EventStore {
  readonly #db: Db;
  readonly #st: Statements;
  /** 本 store 打开的会话，仅用于 close() 时清理；判定归属看 `PROCESS_HANDLES` */
  readonly #open = new Set<SessionId>();
  /** 库的身份。内存库彼此独立，所以各给一个唯一值而不是共用 `:memory:` 这个字符串 */
  readonly #dbKey: string;
  #closed = false;

  constructor(options: SqliteEventStoreOptions) {
    this.#db = new Database(options.path);
    this.#dbKey =
      options.path === ':memory:' ? `mem:${randomUUID()}` : resolve(options.path);

    /*
     * WAL：多读者 + 单写者，正是本架构的形状（不变量四）。
     * synchronous=NORMAL：WAL 下不等每次 fsync——已提交的事务不会丢，崩溃最多丢掉
     * 最后一个未提交事务。事件追加是每轮几十到几百次的高频操作，FULL 的代价是真实的。
     * 内存库不支持 WAL，跳过。
     */
    if (options.path !== ':memory:') {
      this.#db.pragma('journal_mode = WAL');
    }
    this.#db.pragma('synchronous = NORMAL');
    this.#db.pragma('foreign_keys = ON');

    migrate(this.#db);

    this.#st = {
      selectSession: this.#db.prepare(`SELECT * FROM sessions WHERE id = ?`),
      upsertSession: this.#db.prepare(`
        INSERT INTO sessions (id, title, parent_session_id, created_at, updated_at, last_seq)
        VALUES (@id, @title, @parent_session_id, @created_at, @updated_at, @last_seq)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          parent_session_id = excluded.parent_session_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_seq = excluded.last_seq
      `),
      insertEvent: this.#db.prepare(`
        INSERT INTO events (session_id, seq, id, type, ts, turn_id, v, payload_json)
        VALUES (@session_id, @seq, @id, @type, @ts, @turn_id, @v, @payload_json)
      `),
      selectPage: this.#db.prepare(`
        SELECT * FROM events
        WHERE session_id = ? AND seq >= ? AND seq <= ?
        ORDER BY seq LIMIT ?
      `),
      listSessions: this.#db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`),
      selectLease: this.#db.prepare(`SELECT * FROM write_leases WHERE session_id = ?`),
      putLease: this.#db.prepare(`
        INSERT OR REPLACE INTO write_leases (session_id, pid, instance_id, acquired_at)
        VALUES (?, ?, ?, ?)
      `),
      dropLease: this.#db.prepare(`DELETE FROM write_leases WHERE session_id = ?`),
    };
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    this.#assertOpen();
    const rows = this.#st.listSessions.all() as SessionRow[];
    return Promise.resolve(rows.map(toSummary));
  }

  /**
   * 流式读取。绝不 `all()`：一个用了几个月的会话有几万条事件，一次性物化会在打开会话时
   * 占掉几十 MB 并阻塞主进程（端口注释里的硬要求）。
   *
   * 用**分页**而不是 `iterate()` 游标，是一个被 better-sqlite3 的同步模型逼出来的选择：
   * 游标要跨越 `yield` 一直开着，而消费方在两次 `yield` 之间完全可能往同一个连接上写
   * （UI 一边回放一边有新事件进来就是这个形状），那时连接是 busy 的。
   * 分页把"每次拿一批"变成一个个独立的短查询，中间的连接是空闲的——
   * 内存占用仍然是有界的（一页），而调用方看到的语义完全一样。
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async *read(sessionId: SessionId, options?: ReadOptions): AsyncIterable<PersistedEvent> {
    this.#assertOpen();
    const to = options?.toSeq ?? Number.MAX_SAFE_INTEGER;
    let from = options?.fromSeq ?? 1;

    for (;;) {
      const rows = this.#st.selectPage.all(sessionId, from, to, READ_PAGE) as EventRow[];
      for (const row of rows) yield toEvent(row);
      if (rows.length < READ_PAGE) return;
      const last = rows[rows.length - 1];
      if (last === undefined) return;
      from = last.seq + 1;
    }
  }

  /**
   * 失败一律以**拒绝的 Promise** 表达，不同步抛出。
   *
   * 这不是风格问题：`WriteLeaseError` 是正常的运行时状况（另一个窗口开着同一个会话），
   * 调用方多半写成 `store.openForWrite(id).catch(...)`——而 better-sqlite3 是同步的，
   * 一不小心整条路径就变成同步抛出，`.catch` 一次也不会跑到。
   * 契约里有一条专门盯这件事。
   */
  // `async` 在这里是**功能性**的，不是装饰：它把同步抛出转成拒绝（见上方注释）
  // eslint-disable-next-line @typescript-eslint/require-await
  async openForWrite(sessionId: SessionId): Promise<SessionWriter> {
    this.#assertOpen();
    this.#acquireLease(sessionId);

    // 会话行先占位，行为与 MemoryEventStore 一致：openForWrite 之后它就在 listSessions 里
    if (this.#st.selectSession.get(sessionId) === undefined) {
      this.#st.upsertSession.run(toRow(initialSummary(sessionId)));
    }

    return makeWriter(this.#db, this.#st, this.#open, this.#dbKey, sessionId);
  }

  /**
   * 从事件流重建全部摘要。投影坏了不算数据丢失——这就是"坏了能修回来"的那条路。
   *
   * 与增量维护走的是**同一个** `applyToSummary`，所以两条路径不可能分叉；
   * 契约用例「rebuildSummaries 与增量投影等价」盯的就是这件事。
   */
  async rebuildSummaries(): Promise<void> {
    this.#assertOpen();

    const rows = this.#st.listSessions.all() as SessionRow[];
    const rebuilt: SessionSummary[] = [];
    for (const row of rows) {
      const sessionId = row.id as SessionId;
      let summary = initialSummary(sessionId);
      for await (const e of this.read(sessionId)) summary = applyToSummary(summary, e);
      rebuilt.push(summary);
    }

    // 读完再写：一个事务里把全部摘要换掉，中途崩溃不会留下"一半重建过"的投影
    this.#db.transaction(() => {
      for (const s of rebuilt) this.#st.upsertSession.run(toRow(s));
    })();
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    for (const sessionId of this.#open) {
      this.#st.dropLease.run(sessionId);
      PROCESS_HANDLES.delete(handleKey(this.#dbKey, sessionId));
    }
    this.#open.clear();
    this.#closed = true;
    this.#db.close();
    return Promise.resolve();
  }

  // ── 内部 ──────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#closed) throw new Error('SqliteEventStore 已关闭。');
  }

  /**
   * 取排他标记。
   *
   * ⚠️ **这是一个早期的、友好的错误，不是正确性保证。** 真正的保证是
   * `PRIMARY KEY(session_id, seq)`（不变量三）：即便租约被误判、两个写者同时进来，
   * 第二个的插入也会当场冲突，而不是写出一段错乱的历史。
   *
   * 把租约说成万无一失，比没有租约更危险——那会让人觉得可以省掉主键。
   *
   * 判定规则，以及它保守在哪：
   *   · 本进程留下的租约 + 本进程还持着活句柄 → 拒绝（同进程第二个写者）
   *   · 本进程留下的租约 + 没有活句柄 → 自己上次崩溃的残留，接管
   *   · 别的进程，pid 还活着 → 拒绝
   *   · 别的进程，pid 已经没了 → 接管
   *
   * 最后一条里藏着 **PID 复用**这个残余竞态：进程死了、pid 被系统回收给了别人，
   * `kill(pid, 0)` 就会说"活着"，于是我们保守地拒绝——用户看到的是一个可操作的错误
   * （"会话被另一个进程持有"），而不是一次静默的双写。反过来的误判（该拒绝却接管了）
   * 才是危险的，而它需要 pid 恰好已死，那种情况下接管本来就是对的。
   */
  #acquireLease(sessionId: SessionId): void {
    const existing = this.#st.selectLease.get(sessionId) as LeaseRow | undefined;

    const key = handleKey(this.#dbKey, sessionId);

    if (existing !== undefined) {
      const mine = existing.instance_id === PROCESS_INSTANCE_ID;
      if (mine && PROCESS_HANDLES.has(key)) {
        throw new WriteLeaseError(
          `会话 ${sessionId} 已被本进程的另一个写句柄持有。` +
            `同一会话只允许一个写者（ADR-0013 不变量四）。`,
        );
      }
      if (!mine && isProcessAlive(existing.pid)) {
        throw new WriteLeaseError(
          `会话 ${sessionId} 正被进程 ${String(existing.pid)} 持有` +
            `（取得于 ${new Date(existing.acquired_at).toISOString()}）。` +
            `同一会话只允许一个写者（ADR-0013 不变量四）。`,
        );
      }
      // 到这里：本进程的残留租约，或持有者已经不在了 —— 接管
    }

    this.#st.putLease.run(sessionId, process.pid, PROCESS_INSTANCE_ID, Date.now());
    this.#open.add(sessionId);
    PROCESS_HANDLES.add(key);
  }
}

const handleKey = (dbKey: string, sessionId: SessionId): string => `${dbKey}::${sessionId}`;

// ── 写句柄 ──────────────────────────────────────────────────────

function makeWriter(
  db: Db,
  st: Statements,
  openHandles: Set<SessionId>,
  dbKey: string,
  sessionId: SessionId,
): SessionWriter {
  let handleOpen = true;

  const currentSummary = (): SessionSummary => {
    const row = st.selectSession.get(sessionId) as SessionRow | undefined;
    return row === undefined ? initialSummary(sessionId) : toSummary(row);
  };

  /*
   * 整批一个事务：先全量校验，再逐条插入，最后在**同一个事务里**更新摘要。
   *
   * 校验中途抛出会让 better-sqlite3 回滚，于是"半批写入"在结构上就不可能——
   * 那正是不变量一要的：一次工具调用产出 tool.end + usage.recorded，只落前一半，
   * 回放出的成本就永久少一截，而且没人会发现。
   *
   * 摘要与事件同事务是不变量六之外的另一条（决策六）：分两次写，崩在中间会留下
   * "事件在、会话列表里没有"的会话，用户再也找不到它。
   */
  const appendTx = db.transaction((events: readonly SealedEvent[]): number => {
    let summary = currentSummary();
    let expected = summary.lastSeq + 1;

    for (const e of events) {
      if (e.sessionId !== sessionId || e.seq !== expected) {
        throw new SeqConflictError(sessionId, expected, e.seq);
      }
      expected += 1;
    }

    const first = events[0];
    if (summary.lastSeq === 0 && first !== undefined && first.type !== 'session.created') {
      throw new Error(
        `会话 ${sessionId} 的首条事件是 "${first.type}"，必须是 session.created。` +
          `没有它，会话就没有 cwd 与模型引用，回放不出可用状态。`,
      );
    }

    for (const e of events) {
      st.insertEvent.run({
        session_id: e.sessionId,
        seq: e.seq,
        id: e.id,
        type: e.type,
        ts: e.ts,
        turn_id: e.turnId ?? null,
        v: e.v,
        payload_json: JSON.stringify(e.payload),
      });
      summary = applyToSummary(summary, e);
    }

    st.upsertSession.run(toRow(summary));
    return summary.lastSeq;
  });

  let lastSeq = currentSummary().lastSeq;

  return {
    sessionId,
    get lastSeq() {
      return lastSeq;
    },

    // 同上：`async` 让 better-sqlite3 的同步抛出变成拒绝，`.catch` 才接得到
    // eslint-disable-next-line @typescript-eslint/require-await
    async append(events: readonly SealedEvent[]): Promise<void> {
      if (!handleOpen) {
        throw new WriteLeaseError(`会话 ${sessionId} 的写句柄已关闭。`);
      }
      if (events.length === 0) return;
      lastSeq = appendTx(events);
    },

    close(): Promise<void> {
      if (handleOpen) {
        handleOpen = false;
        openHandles.delete(sessionId);
        PROCESS_HANDLES.delete(handleKey(dbKey, sessionId));
        st.dropLease.run(sessionId);
      }
      return Promise.resolve();
    },
  };
}

// ── 行 ↔ 领域对象 ────────────────────────────────────────────────

const toSummary = (row: SessionRow): SessionSummary => ({
  sessionId: row.id as SessionId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastSeq: row.last_seq,
  ...(row.title === null ? {} : { title: row.title }),
  ...(row.parent_session_id === null
    ? {}
    : { parentSessionId: row.parent_session_id as SessionId }),
});

const toRow = (s: SessionSummary): SessionRow => ({
  id: s.sessionId,
  title: s.title ?? null,
  parent_session_id: s.parentSessionId ?? null,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
  last_seq: s.lastSeq,
});

/**
 * 读取路径走 `parseStoredEvent`：有版本闸门、有 upcaster、有全量校验。
 * 绕过它直接 `JSON.parse` 就等于把 ADR-0008 的版本演进整个丢掉。
 */
function toEvent(row: EventRow): PersistedEvent {
  const parsed = parseStoredEvent({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    v: row.v,
    payload: JSON.parse(row.payload_json) as unknown,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  });

  if (!isCoreEvent(parsed) || !isPersistedEvent(parsed)) {
    throw new Error(
      `库里的事件 "${row.type}"（seq=${String(row.seq)}）不是持久化事件。` +
        `它本就不该被写进来——这条记录只可能是绕过 sealEvent() 产生的（不变量二、六）。`,
    );
  }
  return parsed;
}

/**
 * 进程是否还活着。`kill(pid, 0)` 不发信号，只做存在性与权限检查。
 * `EPERM` 表示进程存在但不属于本用户——那同样算"活着"。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
