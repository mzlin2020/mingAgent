import type { AbortLike } from '../tool/types.js';

export type WorkspaceIndexState = 'cold' | 'building' | 'ready' | 'stale' | 'failed';

export interface WorkspaceIndexRefresh {
  readonly state: WorkspaceIndexState;
  readonly indexed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly errors: readonly string[];
}

export interface IndexedTextMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
}

export interface IndexedSymbol {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  readonly signature: string;
}

export interface WorkspaceIndexRootStats {
  readonly root: string;
  readonly state: WorkspaceIndexState;
  readonly fileCount: number;
  readonly sourceBytes: number;
  readonly updatedAt: number;
}

export interface WorkspaceIndexStats {
  readonly roots: readonly WorkspaceIndexRootStats[];
}

/**
 * 查询范围。
 *
 * `root` 是**工作区身份**，由装配层给出（会话 cwd），不由模型选；`pathPrefix` 才是模型
 * 可以指定的子目录过滤（相对 `root`，`/` 分隔）。
 *
 * 两者分开是 ADR-0051 的核心：原来把模型给的 `path` 直接当 root，模型查一次子目录就会
 * 另建一整份索引（含全文副本），而装配层预热用的又是会话 cwd，两个 key 对不上，
 * 预热出来的索引永远命中不到。
 */
export interface WorkspaceQuery {
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix?: string;
}

/** 可重建工作区索引端口；实现含 I/O，但契约保持纯数据。 */
export interface WorkspaceIndex {
  state(root: string): WorkspaceIndexState;
  stats(): WorkspaceIndexStats;
  refresh(root: string, signal: AbortLike): Promise<WorkspaceIndexRefresh>;
  /** 删除全部可重建索引内容；不会触碰工作区源文件。 */
  clear(): Promise<void>;
  searchText(query: WorkspaceQuery): readonly IndexedTextMatch[];
  searchSymbols(query: WorkspaceQuery): readonly IndexedSymbol[];
  close(): Promise<void>;
}
