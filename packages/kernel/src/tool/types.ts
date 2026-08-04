import type { z } from 'zod';
import type {
  Capability,
  ResourceClaim,
  ResultLimits,
  RiskLevel,
  ToolDescriptor,
  ToolProgress,
} from '@xm/contracts';

/**
 * 取消信号的**最小结构**。
 *
 * 刻意不用 `AbortSignal`：那个类型来自 DOM lib 或 @types/node，把任一个引进来
 * 都会让内核在编译期看到 `document` / `fs` 之类的东西，削弱"内核零 I/O"的保证。
 * 真实的 AbortSignal 结构上兼容这个接口，适配层直接传进来即可。
 */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ToolContext {
  readonly signal: AbortLike;
  /** 工作区根目录。工具自己解析相对路径，内核不碰文件系统 */
  readonly cwd: string;
  readonly executor: 'local' | 'container' | 'remote';
}

/**
 * 工具定义。
 *
 * 它含函数，所以**不可序列化、跨不了进程**——因此留在 kernel，而不是 contracts。
 * 跨进程传输的是从它派生出的 `ToolDescriptor`。这条分界让内置工具、插件工具、
 * MCP 工具在注册表里长得完全一样。
 */
export interface ToolSpec<I> {
  /** 形如 "fs.read"，必须带分组前缀 */
  readonly name: string;
  readonly group: string;
  /** 进提示词，计入 token 预算 */
  readonly description: string;
  /** 必须落在可序列化子集内，注册时由 assertToolSchema 强制 */
  readonly inputSchema: z.ZodType<I>;
  readonly risk: RiskLevel;
  readonly capabilities: readonly Capability[];
  readonly concurrency?: 'parallel' | 'exclusive';
  readonly resultLimits?: Partial<ResultLimits>;
  readonly source?: ToolDescriptor['source'];

  /**
   * 声明本次调用会碰到的资源，用于并发冲突检测（ADR-0005）。
   * 声明不了就别实现——注册表会把它降级为 exclusive，宁可串行也不要数据竞争。
   */
  resources?(input: I): readonly ResourceClaim[];

  /**
   * 执行。产出 progress 流，最后一条必须是 `kind: 'result'`。
   * 失败不要 throw——转成 `result` 里的错误内容回灌给模型（见 contracts/base/error.ts）。
   */
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolProgress>;
}

/**
 * 注册后的工具：入参已类型擦除。
 *
 * 擦除是必要的——注册表要把不同入参类型的工具放进同一个 Map，而 `Map<string, Tool<?>>`
 * 里的 `?` 无法表达。校验在 `execute` 内部先做，所以擦除不会削弱安全性：
 * 外部只能传 `unknown`，进去第一件事就是 strict parse。
 */
export interface RegisteredTool {
  readonly descriptor: ToolDescriptor;
  readonly inputSchema: z.ZodType;
  /** 传入**未校验**的原始入参；内部先 strict parse，不通过则抛 ToolInputError */
  execute(rawInput: unknown, ctx: ToolContext): AsyncIterable<ToolProgress>;
  resources(rawInput: unknown): readonly ResourceClaim[];
}
