import type { AbortLike, OsFamily, RegisteredTool, WorkspaceIndex } from '@xm/kernel';
import type { ResultExpandOptions, SubagentExplorer, TodoUpdater } from '@xm/runtime';
import { resultExpandTool, subagentExploreTool, todoUpdateTool } from '@xm/runtime';
import { coreTools, editApplyTool, editPreviewTool, shellSessionTools } from '@xm/tools-core';
import type { EditProposalAccess, PtySessionManager } from '@xm/tools-core';

/** 桌面端的生产工具装配点。演示工具刻意不进这份名单。 */
export function productionTools(options: {
  readonly os: OsFamily;
  readonly ptySessions: PtySessionManager;
  readonly updateTodos: TodoUpdater;
  readonly expandResults: ResultExpandOptions;
  readonly editProposals: EditProposalAccess;
  readonly index: WorkspaceIndex;
  /** 应用级后台信号，交给索引的增量刷新用（ADR-0051） */
  readonly backgroundSignal: AbortLike;
  readonly explore: SubagentExplorer;
}): readonly RegisteredTool[] {
  return [
    ...coreTools({
      os: options.os,
      index: options.index,
      backgroundSignal: options.backgroundSignal,
    }),
    ...shellSessionTools(options.ptySessions),
    todoUpdateTool(options.updateTodos),
    resultExpandTool(options.expandResults),
    editPreviewTool(options.editProposals),
    editApplyTool(options.editProposals),
    subagentExploreTool(options.explore),
  ];
}
