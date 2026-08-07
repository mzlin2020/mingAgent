import type { z } from 'zod';
import type {
  Capability,
  ResourceClaim,
  ResultLimits,
  RiskLevel,
  SessionId,
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
  /** 归属会话。工具产出的事件、审计记录、子 Agent 派生都要挂在它上面 */
  readonly sessionId: SessionId;
  readonly signal: AbortLike;
  /** 工作区根目录。工具自己解析相对路径，内核不碰文件系统 */
  readonly cwd: string;
  readonly executor: 'local' | 'container' | 'remote';
}

/**
 * `available()` 的判定上下文 —— 只含**不随单次调用变化**的事实。
 *
 * 与 `ToolContext` 分开是刻意的：可用性决定的是"工具进不进提示词"，
 * 而提示词要能被 prompt cache 命中。如果这里能看到 signal 之类的每次调用都不同的东西，
 * 工具列表就会逐轮抖动，缓存全失效（ADR-0006 的派生约束）。
 */
export interface ToolAvailabilityContext {
  readonly cwd: string;
  readonly executor: 'local' | 'container' | 'remote';
  /** 由 PlatformPort 探测得出，如 `computer.input`（Linux 上不可用，ADR-0007） */
  readonly platformCapabilities: readonly Capability[];
  /** 配置里显式禁用的工具名（Config.tools.disabled） */
  readonly disabledTools: readonly string[];
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
   * 哪些入参字段是**文件系统路径**，按判权重要性排序（第一个用作 target）。
   *
   * 能力网关据此把相对路径变绝对、把符号链接与 Windows 短名解析掉，
   * 并**回写进入参**——判定与执行因此用的是同一个字符串（见 `port/tool-gateway.ts`）。
   *
   * ⚠️ **不进 `ToolDescriptor`。** 模型不需要知道我们内部怎么解析它给的路径，
   * 而描述符的每个字段都要进提示词、占 token。
   *
   * 声明了路径类能力（`fs.*` / `self.modify`）却不声明这个字段，就等于告诉网关
   * "这次调用没有路径"——`nodeToolGateway` 会当场拒绝，而不是默默按未解析的路径判。
   */
  readonly pathInputs?: readonly string[];

  /**
   * 哪个入参字段是**命令行**（ADR-0026）。与 `pathInputs` 并列，同样不进 `ToolDescriptor`。
   *
   * `argv` 字段必须是一个字符串数组——**不接受一整条命令串**。接受整串就等于把
   * "这条命令到底分成几个词"这个问题留给某一层去猜，而那正是命令行判定所有麻烦的源头。
   *
   * 声明了命令类能力（`shell.exec` / `process.spawn`）却不声明这个字段，
   * 网关会当场拒绝——与 `pathInputs` 那道检查同一个形状、同一个理由：
   * 不知道命令是什么，就判不出它会动什么，而"判不出"绝不能落成"放行"。
   */
  readonly commandInputs?: {
    readonly argv: string;
    /** 命令的工作目录字段。省略则用会话的 cwd */
    readonly cwd?: string;
  };

  /**
   * 动态可用性：不满足条件时该工具**不进模型视野**（docs/04 §4.3）。
   *
   * 典型用途：无 git 仓库就不暴露 git 工具集；Linux 上 `computer.*` 探测为不可用，
   * 工具从提示词里消失、UI 灰显（ADR-0007 Tier 3）。
   *
   * ⚠️ 必须是**纯函数且结果稳定**。它的返回值直接决定提示词里的工具列表，
   * 而工具列表是 prompt cache 稳定前缀的一部分——让它依赖每轮都在变的东西
   * （时间、随机、上一次调用结果），就等于每轮缓存全失效（ADR-0006）。
   */
  available?(ctx: ToolAvailabilityContext): boolean;

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
  /** 见 `ToolSpec.pathInputs`。空数组表示"这个工具没有路径入参" */
  readonly pathInputs: readonly string[];
  /** 见 `ToolSpec.commandInputs`。缺席表示"这个工具不跑命令" */
  readonly commandInputs?: ToolSpec<unknown>['commandInputs'];
  /**
   * 只校验、不执行。不通过抛 `ToolInputError`。
   *
   * 存在的理由是**权限判定必须看到工具真正会执行的那个值**：入参 schema 允许
   * `.default()`，原始 JSON 与校验后的对象因此可能不同，而 `targetOf()` 从中取
   * 判权用的 target。拿未校验的原始值去判、拿校验后的值去执行，两者分叉就是
   * 权限判定上的 TOCTOU（turn.ts 的 `dispatchCall` 因此先调它）。
   *
   * 返回 `unknown` 而不是 `I`：注册表已经把入参类型擦除了（见本接口顶部注释）。
   */
  parseInput(rawInput: unknown): unknown;
  /** 传入**未校验**的原始入参；内部先 strict parse，不通过则抛 ToolInputError */
  execute(rawInput: unknown, ctx: ToolContext): AsyncIterable<ToolProgress>;
  resources(rawInput: unknown): readonly ResourceClaim[];
  /** 未声明 `available()` 的工具恒为可用 */
  available(ctx: ToolAvailabilityContext): boolean;
}
