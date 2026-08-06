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
export * from './fs-read.js';
export * from './fs-list.js';
export * from './fs-write.js';

import type { RegisteredTool } from '@xm/kernel';
import { fsListTool } from './fs-list.js';
import { fsReadTool } from './fs-read.js';
import { fsWriteTool } from './fs-write.js';

/**
 * 这一批的全部工具。
 *
 * 做成一个函数而不是数组常量：`RegisteredTool` 里带着闭包，同一个实例被两个
 * `ToolRegistry` 注册没有坏处，但"工具集是现造的"这个形状让将来按配置裁剪
 * （`tools.disabled`）不用改调用方。
 */
export const coreTools = (): RegisteredTool[] => [fsReadTool(), fsListTool(), fsWriteTool()];
