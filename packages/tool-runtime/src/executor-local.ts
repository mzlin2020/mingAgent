import type { ExecutionWorld } from '@xm/kernel';
import { localExecutionFileSystem } from './executor-local-fs.js';
import { localExecutionProcess } from './executor-local-process.js';
import { localExecutionPty } from './executor-local-pty.js';

export const createLocalExecutionWorld = (): ExecutionWorld => ({
  kind: 'local',
  capabilities: Object.freeze({ filesystem: true, process: true, pty: true }),
  fs: localExecutionFileSystem(),
  process: localExecutionProcess(),
  pty: localExecutionPty(),
});

/** 无可变会话状态，可在同一进程的装配与测试之间共享。 */
export const localExecutionWorld: ExecutionWorld = createLocalExecutionWorld();
