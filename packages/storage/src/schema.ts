import type { Database } from 'better-sqlite3';
import { StoreCorruptionError, StoreVersionError } from '@xm/kernel';

/**
 * 事件库的表结构与迁移（ADR-0013 / ADR-0016）。
 *
 * 迁移写成有序数组而不是"一坨建表 SQL"，是因为第二条迁移出现时才补框架必然要动第一条，
 * 而那时库里已经有真实数据了。现在只有一条，结构却已经定死。
 */

export const SUPPORTED_STORE_VERSION = 2;

interface Migration {
  readonly to: number;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- 会话摘要 = SessionSummary 投影的落地形态。
      -- 它必须与 events 在同一个事务里更新（ADR-0013 决策六）：分两次写，
      -- 崩在中间就会出现"事件在、列表里没有"的会话，用户再也找不到它。
      CREATE TABLE sessions (
        id                TEXT PRIMARY KEY,
        title             TEXT,
        parent_session_id TEXT,
        created_at        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0,
        last_seq          INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sessions_by_updated ON sessions(updated_at DESC);

      -- append-only，永不 UPDATE、永不 DELETE。
      -- PRIMARY KEY(session_id, seq) 是**并发写检测器**，不是索引优化（不变量三）：
      -- 插入冲突即说明有第二个写者，属于必须立刻崩溃的不变量破坏。
      CREATE TABLE events (
        session_id   TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        id           TEXT    NOT NULL,
        type         TEXT    NOT NULL,
        ts           INTEGER NOT NULL,
        turn_id      TEXT,
        v            INTEGER NOT NULL,
        payload_json TEXT    NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;

      -- 会话级排他标记。它是一个**早期的、友好的错误**，不是正确性保证——
      -- 正确性保证是上面那个主键。理由见 sqlite-event-store.ts 的租约注释。
      CREATE TABLE write_leases (
        session_id  TEXT PRIMARY KEY,
        pid         INTEGER NOT NULL,
        instance_id TEXT    NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `,
  },
  {
    to: 2,
    sql: `
      -- 会话状态快照（ADR-0032，修 G4 会话回放超线性 / G5 IPC 全量物化）。
      -- **纯派生数据**：坏了、删了、这张表整个清空，都可以从 events 表重新
      -- reduceAll 出来——它不是事件溯源的"唯一事实来源"的例外，只是一个
      -- 缓存。每个会话只留最新一份（PRIMARY KEY 是 session_id 本身，
      -- 不是 (session_id, seq)），旧快照没有独立价值。
      CREATE TABLE snapshots (
        session_id TEXT PRIMARY KEY,
        seq        INTEGER NOT NULL,
        state_json TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

/**
 * 打开库时的版本闸门 + 迁移。
 *
 * 库版本高于本机 → `StoreVersionError`，**不做任何降级解释**。与 `parseStoredEvent`
 * 对未来版本事件的处理保持一致（ADR-0012 ⑤）：宁可打不开，也不要用旧代码的理解去读
 * 新结构。区别只在层次——那条管 payload，这条管表结构。
 */
export function migrate(db: Database): number {
  const found = readVersion(db);

  if (found > SUPPORTED_STORE_VERSION) {
    throw new StoreVersionError(found, SUPPORTED_STORE_VERSION);
  }

  const pending = MIGRATIONS.filter((m) => m.to > found);
  if (pending.length === 0) return found;

  // 迁移整体一个事务：崩在中间留下半套表，比没迁移更难收拾
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
        String(m.to),
      );
    }
  })();

  return SUPPORTED_STORE_VERSION;
}

function readVersion(db: Database): number {
  const hasMeta = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  if (hasMeta === undefined) return 0;

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (row === undefined) return 0;
  if (!/^\d+$/.test(row.value)) {
    throw new StoreCorruptionError(
      `事件库 meta.schema_version 的值 ${JSON.stringify(row.value)} 不是非负整数，拒绝迁移。`,
    );
  }
  const version = Number(row.value);
  if (!Number.isSafeInteger(version)) {
    throw new StoreCorruptionError(
      `事件库 meta.schema_version 的值 ${JSON.stringify(row.value)} 超出安全整数范围，拒绝迁移。`,
    );
  }
  return version;
}
