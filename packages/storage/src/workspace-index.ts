import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type {
  AbortLike,
  IndexedSymbol,
  IndexedTextMatch,
  WorkspaceIndex,
  WorkspaceIndexRefresh,
  WorkspaceIndexState,
  WorkspaceQuery,
} from '@xm/kernel';
import { extractSymbols, supportsSymbols, symbolDegradation } from './tree-symbols.js';

const MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.json', '.md', '.mjs', '.mts', '.php', '.ps1', '.py', '.rb', '.rs', '.sh', '.toml', '.ts',
  '.tsx', '.txt', '.yaml', '.yml',
]);

export interface WorkspaceIndexOptions {
  /** ripgrep 可执行名。测试用一个必然启动不了的名字来覆盖纯 Node 枚举那条路径。 */
  readonly ripgrep?: string;
}

export async function openWorkspaceIndex(
  path: string,
  options: WorkspaceIndexOptions = {},
): Promise<WorkspaceIndex> {
  await mkdir(dirname(path), { recursive: true });
  const existed = await exists(path);
  try {
    return new SqliteWorkspaceIndex(path, options);
  } catch (error) {
    if (!existed) throw error;
    await removeDatabase(path);
    return new SqliteWorkspaceIndex(path, options);
  }
}

class SqliteWorkspaceIndex implements WorkspaceIndex {
  readonly #db: Db;
  readonly #refreshing = new Map<string, Promise<WorkspaceIndexRefresh>>();
  readonly #ripgrep: string;
  #closed = false;

  constructor(path: string, options: WorkspaceIndexOptions = {}) {
    this.#ripgrep = options.ripgrep ?? 'rg';
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA);
      db.prepare(`UPDATE workspaces SET state = 'stale' WHERE state = 'building'`).run();
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
  }

  state(root: string): WorkspaceIndexState {
    const row = this.#db.prepare('SELECT state FROM workspaces WHERE root = ?').get(root) as
      | { state: WorkspaceIndexState }
      | undefined;
    return row?.state ?? 'cold';
  }

  refresh(root: string, signal: AbortLike): Promise<WorkspaceIndexRefresh> {
    if (this.#closed) return Promise.reject(new Error('工作区索引已经关闭。'));
    const active = this.#refreshing.get(root);
    if (active !== undefined) return active;
    const pending = this.#refresh(root, signal).finally(() => {
      this.#refreshing.delete(root);
    });
    this.#refreshing.set(root, pending);
    return pending;
  }

  searchText({ root, query, limit, pathPrefix }: WorkspaceQuery): readonly IndexedTextMatch[] {
    const expression = `"${query.replaceAll('"', '""')}"`;
    const rows = this.#db.prepare(`
      SELECT files.path AS path, files.content AS content
      FROM file_fts JOIN files
        ON files.root = file_fts.root AND files.path = file_fts.path
      WHERE file_fts MATCH ? AND file_fts.root = ? AND files.path LIKE ? ESCAPE '\\'
      ORDER BY files.path
      LIMIT ?
    `).all(expression, root, likePrefix(pathPrefix), limit) as { path: string; content: string }[];
    const matches: IndexedTextMatch[] = [];
    for (const row of rows) {
      for (const match of occurrences(row.path, row.content, query)) {
        matches.push(match);
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }

  searchSymbols({ root, query, limit, pathPrefix }: WorkspaceQuery): readonly IndexedSymbol[] {
    const pattern = `%${escapeLike(query)}%`;
    return this.#db.prepare(`
      SELECT path, name, kind, line, column, signature
      FROM symbols
      WHERE root = ? AND name LIKE ? ESCAPE '\\' AND path LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, name, path, line
      LIMIT ?
    `).all(root, pattern, likePrefix(pathPrefix), query, limit) as IndexedSymbol[];
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.#refreshing.values());
    this.#db.close();
  }

  async #refresh(root: string, signal: AbortLike): Promise<WorkspaceIndexRefresh> {
    /*
     * 已经 ready 的索引在增量刷新期间保持 ready（ADR-0051）。
     *
     * 原来无条件置 building，配上"查询后台触发刷新"就成了一个来回摆：查一次 → 置
     * building → 下一次查询看到不是 ready → 退回文本搜索 → 又触发一次刷新。
     * building 的本意是"还没有可用索引"，而不是"正在更新"——一份已建好的索引在增量
     * 更新期间仍然可用，结果最多稍旧，这正是 ADR-0047 明说可以接受的。
     */
    const buildingFirstTime = this.state(root) !== 'ready';
    if (buildingFirstTime) this.#setState(root, 'building');
    const errors: string[] = [];
    let indexed = 0;
    let unchanged = 0;
    let removed = 0;
    try {
      if (isAborted(signal)) {
        this.#setState(root, 'stale');
        return { state: 'stale', indexed, unchanged, removed, errors };
      }
      const paths = await listFiles(root, signal, this.#ripgrep);
      const existing = new Map(
        (this.#db.prepare('SELECT path, mtime_ms, size FROM files WHERE root = ?').all(root) as
          { path: string; mtime_ms: number; size: number }[])
          .map((row) => [row.path, row]),
      );
      const current = new Set<string>();
      for (const path of paths) {
        if (isAborted(signal)) {
          this.#setState(root, 'stale');
          return { state: 'stale', indexed, unchanged, removed, errors };
        }
        const absolute = join(root, path);
        try {
          const info = await stat(absolute);
          if (!info.isFile() || info.size > MAX_FILE_BYTES || !isTextPath(path)) continue;
          const mtime = Math.trunc(info.mtimeMs);
          const old = existing.get(path);
          if (old?.mtime_ms === mtime && old.size === info.size) {
            current.add(path);
            unchanged += 1;
            continue;
          }
          const content = await readFile(absolute, 'utf8');
          if (content.includes('\0')) continue;
          const symbols = supportsSymbols(path) ? await extractSymbols(path, content) : [];
          current.add(path);
          this.#replace(root, path, mtime, info.size, content, symbols);
          indexed += 1;
        } catch (error) {
          errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const path of existing.keys()) {
        if (current.has(path)) continue;
        this.#remove(root, path);
        removed += 1;
      }
      /*
       * 扫描跑完就是 ready，即使个别文件读不了（ADR-0051）。
       *
       * 原来是 `errors.length === 0 ? 'ready' : 'stale'`：一个权限不足的文件、一条断掉的
       * 符号链接，就能让整库永久 stale，此后每次查询都 fallback 并再触发一次全量重扫——
       * 一个稳定的重扫循环。逐文件错误照旧回传给调用方，但它不是整库的健康状态。
       */
      // 符号能力若已降级（WASM 资产缺失等），从这条既有通道说出来，不是无声返回空符号
      const degraded = symbolDegradation();
      if (degraded !== undefined) errors.push(degraded);
      this.#setState(root, 'ready');
      return { state: 'ready', indexed, unchanged, removed, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      this.#setState(root, signal.aborted ? 'stale' : 'failed');
      return { state: signal.aborted ? 'stale' : 'failed', indexed, unchanged, removed, errors };
    }
  }

  #replace(
    root: string,
    path: string,
    mtime: number,
    size: number,
    content: string,
    symbols: readonly IndexedSymbol[],
  ): void {
    this.#db.transaction(() => {
      this.#remove(root, path);
      this.#db.prepare('INSERT INTO files(root,path,mtime_ms,size,content) VALUES (?,?,?,?,?)')
        .run(root, path, mtime, size, content);
      this.#db.prepare('INSERT INTO file_fts(root,path,content) VALUES (?,?,?)')
        .run(root, path, content);
      const insert = this.#db.prepare(`
        INSERT INTO symbols(root,path,name,kind,line,column,signature) VALUES (?,?,?,?,?,?,?)
      `);
      for (const symbol of symbols) {
        insert.run(root, path, symbol.name, symbol.kind, symbol.line, symbol.column, symbol.signature);
      }
    })();
  }

  #remove(root: string, path: string): void {
    this.#db.prepare('DELETE FROM symbols WHERE root = ? AND path = ?').run(root, path);
    this.#db.prepare('DELETE FROM file_fts WHERE root = ? AND path = ?').run(root, path);
    this.#db.prepare('DELETE FROM files WHERE root = ? AND path = ?').run(root, path);
  }

  #setState(root: string, state: WorkspaceIndexState): void {
    this.#db.prepare(`
      INSERT INTO workspaces(root,state,updated_at) VALUES (?,?,?)
      ON CONFLICT(root) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
    `).run(root, state, Date.now());
  }
}

const SCHEMA = `
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

/**
 * 枚举工作区里要索引的文件。
 *
 * ripgrep 优先——它顺带把 `.gitignore` 也遵守了，这是纯 Node 遍历给不了的。但它**不能是
 * 前提**：普通用户机器上多半没有 rg，而 M2-g 原来在这里直接 reject，于是索引根本建不起来
 * （ADR-0051）。启动不了就退到 Node 遍历，只按固定名单排除依赖/构建目录。
 */
async function listFiles(
  root: string,
  signal: AbortLike,
  executable: string,
): Promise<readonly string[]> {
  const viaRipgrep = await ripgrepFiles(root, signal, executable);
  return viaRipgrep ?? walkFiles(root, signal);
}

/** rg 不可用时返回 undefined；rg 自身报错（不是启动失败）仍然抛，那是真问题。 */
function ripgrepFiles(
  root: string,
  signal: AbortLike,
  executable: string,
): Promise<readonly string[] | undefined> {
  return new Promise<readonly string[] | undefined>((done, reject) => {
    const child = spawn(executable, [
      '--files', '--hidden', '--null',
      '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**',
      '--glob', '!coverage/**', '--glob', '!release/**',
    ], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let spawnFailed = false;
    const abort = (): void => { child.kill(); };
    signal.addEventListener('abort', abort);
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (spawnFailed) { done(undefined); return; }
      if (signal.aborted) { done([]); return; }
      if (code !== 0) { reject(new Error(`rg --files 失败（${String(code)}）：${stderr.trim()}`)); return; }
      done(
        Buffer.concat(chunks)
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
          .map((path) => path.replaceAll('\\', '/')),
      );
    });
  });
}

/** 排除名单与 rg 那条路径对齐；额外跳过隐藏目录，因为没有 `.gitignore` 兜底。 */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'coverage', 'release', 'build', 'out', 'target', '__pycache__',
]);

async function walkFiles(root: string, signal: AbortLike): Promise<readonly string[]> {
  const found: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    if (signal.aborted) return found;
    const relative = pending.pop() ?? '';
    let children;
    try {
      children = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const path = relative === '' ? child.name : `${relative}/${child.name}`;
      // 不跟随符号链接：一个指回上层的链接足以让遍历打转
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(child.name) && !child.name.startsWith('.')) pending.push(path);
      } else if (child.isFile()) {
        found.push(path);
      }
    }
  }
  return found;
}

function occurrences(path: string, content: string, query: string): readonly IndexedTextMatch[] {
  const matches: IndexedTextMatch[] = [];
  const haystack = content.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  let scanned = 0;
  let line = 1;
  let lineStart = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    for (let newline = content.indexOf('\n', scanned);
      newline !== -1 && newline < offset;
      newline = content.indexOf('\n', scanned)) {
      line += 1;
      lineStart = newline + 1;
      scanned = lineStart;
    }
    const lineEnd = content.indexOf('\n', offset);
    matches.push({
      path,
      line,
      column: Array.from(content.slice(lineStart, offset)).length + 1,
      snippet: content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).replace(/\r$/u, ''),
    });
    offset += Math.max(needle.length, 1);
  }
  return matches;
}

/** 相对前缀 → LIKE 模式。省略时匹配全部；`%`/`_`/`\` 先转义，避免模型的路径变成通配符。 */
const likePrefix = (prefix: string | undefined): string =>
  prefix === undefined || prefix === '' ? '%' : `${escapeLike(prefix)}%`;

const isTextPath = (path: string): boolean => TEXT_EXTENSIONS.has(extname(path).toLowerCase());
const isAborted = (signal: AbortLike): boolean => signal.aborted;
const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, (char) => `\\${char}`);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function removeDatabase(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) => rm(file, { force: true })));
}
