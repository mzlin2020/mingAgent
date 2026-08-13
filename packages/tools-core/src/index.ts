/**
 * `@xm/tools-core` —— 基础工具集与它们要的两个运行时零件。
 *
 * 这个包**要 `node:fs`**，与内核的零 I/O 正好互补：内核判定"能不能做"，
 * 这里做"具体怎么做"。两者的接缝是 `ToolSpec` 与两个端口（`ToolGateway`、`Checkpointer`），
 * 都定义在内核里——所以换一个执行后端（容器、SSH，M1-d 之后）只要换这个包。
 *
 * 不依赖 electron（depcruise 强制）：CLI（M3）与 headless 冒烟用的是同一批工具。
 */

export * from './gateway.js';
export * from './checkpoint.js';
export * from './checkpoint-restore.js';
export * from './diff.js';
export * from './edit.js';
export * from './git.js';
export * from './index-search.js';
export * from './fs-read.js';
export * from './fs-list.js';
export * from './fs-write.js';
export * from './search-fallback.js';
export * from './search-text.js';
export * from './shell-exec.js';
export * from './pty-session.js';
export * from './pty-executable.js';
export * from './pty-tools.js';
export * from './web-fetch.js';

import type { RegisteredTool } from '@xm/kernel';
import { fsListTool } from './fs-list.js';
import { fsReadTool } from './fs-read.js';
import { fsWriteTool } from './fs-write.js';
import { gitTools } from './git.js';
import { indexSearchTools } from './index-search.js';
import { textSearchTool } from './search-text.js';
import type { ShellExecOptions } from './shell-exec.js';
import { shellExecTool } from './shell-exec.js';
import { webFetchTool } from './web-fetch.js';

/**
 * 这一批的全部工具。
 *
 * 做成一个函数而不是数组常量：`RegisteredTool` 里带着闭包，同一个实例被两个
 * `ToolRegistry` 注册没有坏处，但"工具集是现造的"这个形状让将来按配置裁剪
 * （`tools.disabled`）不用改调用方。
 */
export interface CoreToolsOptions {
  /**
   * 跑在哪个系统上。**必填**——`shell.exec` 要靠它决定怎么杀掉一棵进程树，
   * 而内核与工具层都不许自己去问 `process.platform`（ADR-0007）。
   * 装配方手里一定有 `PlatformPort.os`，让它传过来，忘了传就编译不过。
   */
  readonly os: ShellExecOptions['os'];
  /** 允许透传给子进程的额外环境变量名 */
  readonly extraEnv?: readonly string[];
  /** M2-g 的可重建工作区索引；未提供时不注册索引增强工具。 */
  readonly index?: import('@xm/kernel').WorkspaceIndex;
  /**
   * 索引后台增量刷新的取消源——应用级信号，**不是**某一次工具调用的 signal。
   * 传错会让后台刷新在 turn 结束时被取消，索引永远停在半成品（ADR-0051）。
   */
  readonly backgroundSignal?: import('@xm/kernel').AbortLike;
}

export const coreTools = (options: CoreToolsOptions): RegisteredTool[] => [
  fsReadTool(),
  fsListTool(),
  fsWriteTool(),
  textSearchTool(),
  shellExecTool(options),
  ...gitTools(options),
  ...(options.index === undefined
    ? []
    : indexSearchTools({
        index: options.index,
        ...(options.backgroundSignal === undefined
          ? {}
          : { backgroundSignal: options.backgroundSignal }),
      })),
  webFetchTool(),
];
