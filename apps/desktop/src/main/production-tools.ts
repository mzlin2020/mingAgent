import type { OsFamily, RegisteredTool } from '@xm/kernel';
import type { ResultExpandOptions, TodoUpdater } from '@xm/runtime';
import { resultExpandTool, todoUpdateTool } from '@xm/runtime';
import { coreTools, shellSessionTools } from '@xm/tools-core';
import type { PtySessionManager } from '@xm/tools-core';

/** The desktop production assembly point. Demo tools intentionally do not enter this list. */
export function productionTools(options: {
  readonly os: OsFamily;
  readonly ptySessions: PtySessionManager;
  readonly updateTodos: TodoUpdater;
  readonly expandResults: ResultExpandOptions;
}): readonly RegisteredTool[] {
  return [
    ...coreTools({ os: options.os }),
    ...shellSessionTools(options.ptySessions),
    todoUpdateTool(options.updateTodos),
    resultExpandTool(options.expandResults),
  ];
}
