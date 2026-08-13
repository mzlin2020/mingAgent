import type { OsFamily, RegisteredTool, WorkspaceIndex } from '@xm/kernel';
import type { ResultExpandOptions, SubagentExplorer, TodoUpdater } from '@xm/runtime';
import { resultExpandTool, subagentExploreTool, todoUpdateTool } from '@xm/runtime';
import { coreTools, editApplyTool, editPreviewTool, shellSessionTools } from '@xm/tools-core';
import type { EditProposalAccess, PtySessionManager } from '@xm/tools-core';

/** The desktop production assembly point. Demo tools intentionally do not enter this list. */
export function productionTools(options: {
  readonly os: OsFamily;
  readonly ptySessions: PtySessionManager;
  readonly updateTodos: TodoUpdater;
  readonly expandResults: ResultExpandOptions;
  readonly editProposals: EditProposalAccess;
  readonly index: WorkspaceIndex;
  readonly explore: SubagentExplorer;
}): readonly RegisteredTool[] {
  return [
    ...coreTools({ os: options.os, index: options.index }),
    ...shellSessionTools(options.ptySessions),
    todoUpdateTool(options.updateTodos),
    resultExpandTool(options.expandResults),
    editPreviewTool(options.editProposals),
    editApplyTool(options.editProposals),
    subagentExploreTool(options.explore),
  ];
}
