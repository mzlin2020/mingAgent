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

/** 可重建工作区索引端口；实现含 I/O，但契约保持纯数据。 */
export interface WorkspaceIndex {
  state(root: string): WorkspaceIndexState;
  refresh(root: string, signal: AbortLike): Promise<WorkspaceIndexRefresh>;
  searchText(root: string, query: string, limit: number): readonly IndexedTextMatch[];
  searchSymbols(root: string, query: string, limit: number): readonly IndexedSymbol[];
  close(): Promise<void>;
}
