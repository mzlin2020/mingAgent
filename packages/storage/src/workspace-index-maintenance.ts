import type { Database as Db } from 'better-sqlite3';
import type { WorkspaceIndexStats } from '@xm/kernel';

export const WORKSPACE_INDEX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    root TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY(root,path)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS symbols (
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    column INTEGER NOT NULL,
    signature TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols(root,name);
  CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
    root UNINDEXED,
    path UNINDEXED,
    content,
    tokenize='trigram'
  );
`;

export function workspaceIndexStats(db: Db): WorkspaceIndexStats {
  const roots = db.prepare(`
    SELECT workspaces.root AS root, workspaces.state AS state,
           workspaces.updated_at AS updatedAt,
           count(files.path) AS fileCount,
           coalesce(sum(files.size), 0) AS sourceBytes
    FROM workspaces LEFT JOIN files ON files.root = workspaces.root
    GROUP BY workspaces.root, workspaces.state, workspaces.updated_at
    ORDER BY workspaces.updated_at DESC
  `).all() as WorkspaceIndexStats['roots'];
  return { roots };
}

export function clearWorkspaceIndex(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM symbols').run();
    db.prepare('DELETE FROM file_fts').run();
    db.prepare('DELETE FROM files').run();
    db.prepare('DELETE FROM workspaces').run();
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
}
