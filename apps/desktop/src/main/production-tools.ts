import type { OsFamily, RegisteredTool } from '@xm/kernel';
import { coreTools, shellSessionTools } from '@xm/tools-core';
import type { PtySessionManager } from '@xm/tools-core';

/** The desktop production assembly point. Demo tools intentionally do not enter this list. */
export function productionTools(options: {
  readonly os: OsFamily;
  readonly ptySessions: PtySessionManager;
}): readonly RegisteredTool[] {
  return [...coreTools({ os: options.os }), ...shellSessionTools(options.ptySessions)];
}
