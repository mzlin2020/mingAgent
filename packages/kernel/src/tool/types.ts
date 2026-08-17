import type { z } from 'zod';
import type {
  CardActionPayload,
  CardActionPayloadKind,
  Capability,
  CallId,
  ResourceClaim,
  ResultLimits,
  RiskLevel,
  SessionId,
  ToolCard,
  ToolDescriptor,
  ToolProgress,
} from '@xm/contracts';
import type { PlatformCapabilities } from '../port/platform.js';
import type { ExecutionWorld } from '../port/execution-world.js';
import type { CodeBindingCall, CodeBindingResult, CodeRuntime } from '../port/code-runtime.js';
import type { AbortLike } from '../port/abort.js';
export type { AbortLike } from '../port/abort.js';

/**
 * Code Mode 的两半：跑程序的地方，和程序调工具时回来的那个门。
 *
 * 两半必须一起给：只给 `runtime` 的话程序跑得起来但什么也做不了；只给 `dispatch`
 * 的话没有地方跑程序。装配层要么两个都装，要么整个字段缺席。
 */
export interface CodeModeSeam {
  /** 隔离运行时。一次 `run_code` 用一个新的客体域（ADR-0069 §三.4） */
  readonly runtime: CodeRuntime;
  /**
   * 把程序发起的一次调用送回**完整十二步链**（ADR-0055）。
   *
   * 它自己给这次调用编号、分配 `callId`、落一条 `tool.code.dispatch`。
   * 被拒绝时返回 `{ ok: false, message }` 而不是抛——那个 message 会成为客体域里的
   * 异常消息，与直接调用时模型看到的拒绝理由一字不差。
   *
   * `signal` 是**这一次 `run_code` 的运行域**（地基复审四 C2）：程序被墙钟掐掉、
   * 被 CPU 预算中断、或者这一轮被用户停掉时它会 abort，在途的子调用必须跟着停。
   * 没有它的话，一次"已终止"的程序仍然会有一个 `shell.exec` 在宿主上不紧不慢地跑完，
   * 把文件写完、把事件落在 `tool.end` 之后——而模型早已经被告知那段程序失败了。
   */
  dispatch(call: CodeBindingCall, signal: AbortLike): Promise<CodeBindingResult>;
  /** 这次能装进客体域的绑定名（可用工具减去 `run_code` 自己，不做嵌套） */
  bindings(): readonly string[];
  /**
   * 已经派发过的子调用，**顺序即发生顺序**。
   *
   * `run_code` 的卡片靠它显示"第几步调了什么"。刻意由接缝持有而不是让工具自己数：
   * 事件里的 `index` 与卡片上的序号必须是同一个计数器，两个各数各的迟早会错开一位，
   * 而那种错位在界面上看不出来——你只会以为审计记的是另一次调用。
   */
  dispatched(): readonly CodeDispatchRecord[];
  /** 客体域里 `Date.now()` 的取值。来自 `ctx.clock`，整段程序内是常量 */
  now(): number;
  /** 客体域里 `Math.random()` 的种子。来自本次调用的 `callId` */
  randomSeed(): string;
}

/** 一次子调用在卡片与审计里的公共事实 */
export interface CodeDispatchRecord {
  readonly index: number;
  readonly name: string;
  readonly ok: boolean;
  /** 失败时的原因，与程序里 catch 到的那句一字不差 */
  readonly message?: string;
}

export interface ToolContext {
  /** 归属会话。工具产出的事件、审计记录、子 Agent 派生都要挂在它上面 */
  readonly sessionId: SessionId;
  /** 当前工具调用；子 Agent 生命周期用它关联 parentCallId。手工直调工具时可缺席。 */
  readonly callId?: CallId;
  readonly signal: AbortLike;
  /** 工作区根目录。工具自己解析相对路径，内核不碰文件系统 */
  readonly cwd: string;
  /** 当前执行世界。工具不得绕过它直接访问 Node I/O（ADR-0054）。 */
  readonly executor: ExecutionWorld;
  /**
   * Code Mode 接缝（ADR-0061 §三 / ADR-0072）。**缺席即没装配**，Code Mode 是 opt-in。
   *
   * ⚠️ 它出现在**每个**工具的上下文里，而不只是 `run_code` 的。这看着像是多给了权限，
   * 其实一点也没多：`dispatch()` 送出去的每一次调用都从头走完整十二步链——网关规范化、
   * 主张完备性、红线判定一步不少，且**不复用**发起方那一次的判定结果。一个工具能通过
   * 它做到的事，它自己声明能力去做也一样做得到，区别只是审计里多一条
   * `tool.code.dispatch` 说清了是谁发起的。
   *
   * 换句话说：这里给出的是**再入口**，不是权限。真正的权限仍然只从 `evaluate()` 来。
   */
  readonly codeMode?: CodeModeSeam;
  /**
   * 网关在判权阶段解析出、且已经通过策略判定的主机地址（M1-d，web.fetch 的
   * IP 级 SSRF 判定）。值是网关那一次 DNS 查询解析出的地址。
   *
   * ⚠️ **键必须用 `pinnedHostKey(url)` 算**，两侧都是（地基复审四 B2）。它是
   * `normalizeHostTarget` 归一后去掉端口的那一段：IPv6 带方括号（`[::1]`）、
   * FQDN 去掉尾点。工具自己按 `new URL(url).hostname` 算一份，这两类 URL 就会
   * 永远查不到——表现是一句"内部错误"，而不是"判定不通过"。
   *
   * ⚠️ **工具只能用这张表里的地址建连，绝不能自己再调一次 DNS。** 判定与执行必须
   * 共用同一个已解析的地址——工具自己重新解析一次，等于在"判权那一刻"与"真正建立
   * 连接那一刻"之间重新打开一个 DNS rebinding 窗口，而这张表存在的唯一理由就是
   * 关掉那个窗口。找不到对应主机名，说明网关没有产出这个能力的解析结果，工具应当
   * 拒绝执行并报内部错误，而不是退化成自己发起一次解析。
   */
  readonly pinnedHosts?: ReadonlyMap<string, { readonly address: string; readonly family: 4 | 6 }>;
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
  /** 只暴露稳定的世界身份与能力探测，不暴露会执行 I/O 的方法。 */
  readonly executor: Pick<ExecutionWorld, 'kind' | 'capabilities'>;
  /** 主机实际功能；与“这次动作需要什么权限”的 Capability 是两个概念。 */
  readonly platform: PlatformCapabilities;
  /** 配置里显式禁用的工具名（Config.tools.disabled） */
  readonly disabledTools: readonly string[];
}

/**
 * 完成态投影拿得到的全部事实（ADR-0058）。
 *
 * **三个字段全部来自已落库的 `tool.end`**，因此实时流与三天后的回放喂给
 * `presentResult` 的是同一份输入——"两条路上都跑、结果必须一致"这条不是靠自觉，
 * 是靠这个接口里没有任何非持久的东西。
 */
export interface ToolResultOutcome<M = unknown> {
  readonly ok: boolean;
  /** 工具随结果 yield 出来、已过 `presentationSchema` 校验的最小事实；畸形或缺席即 undefined */
  readonly presentation?: M;
  /** 已截断的模型可见文本（`tool.end.forModel` 里的 text 块拼接） */
  readonly text: string;
  readonly errorMessage?: string;
}

/**
 * 卡片动作能拿到的执行世界（ADR-0065 步骤 ④ 之前的准备阶段）。
 *
 * 它**没有** `record()`：动作不能自己往事件流里写东西。需要落事件的（例如
 * "这个提案被审阅过了"）走工具本来就持有的窄回调，与 ADR-0041 给 todo 工具的
 * 窄写入口同形同理——给出通用事件入口等于让一次点击能伪造 `tool.end`。
 */
export interface ToolActionContext {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly executor: ExecutionWorld;
  readonly signal: AbortLike;
}

/** 一次动作最终变成的**新工具调用**。它照常进完整十二步链，什么也不继承 */
export interface ToolActionCall {
  readonly name: string;
  readonly args: unknown;
}

/**
 * 工具声明的一个具名动作意图。
 *
 * ⚠️ **`prepare` 产出的是一次调用请求，不是一次执行。** 它返回的 `{name, args}`
 * 会当作模型给出的工具调用一样，从头走网关规范化 → 红线判定 → 分层求值。
 * "用户点的"不构成任何放行理由（ADR-0045 / ADR-0065 §三）。
 */
export interface ToolActionSpec<I, M> {
  /** 给人看的按钮名。**渲染层拿到的只有它和 actionId，没有工具名** */
  readonly label: string;
  readonly payload: CardActionPayloadKind;
  readonly emphasis?: 'primary' | 'secondary';
  prepare(request: {
    readonly input: I;
    readonly presentation: M | undefined;
    readonly payload: CardActionPayload;
    readonly ctx: ToolActionContext;
  }): Promise<ToolActionCall | undefined>;
}

/**
 * 工具定义。
 *
 * 它含函数，所以**不可序列化、跨不了进程**——因此留在 kernel，而不是 contracts。
 * 跨进程传输的是从它派生出的 `ToolDescriptor`。这条分界让内置工具、插件工具、
 * MCP 工具在注册表里长得完全一样。
 *
 * `M` 是这个工具落库的展示事实的类型，由 `presentationSchema` 绑定；
 * `O` 是它的**规范输出值**的类型，由 `outputSchema` 绑定。
 */
export interface ToolSpec<I, M = unknown, O = unknown> {
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
   * 哪些入参字段是**文件系统路径**。普通字段写 `path`；顶层对象数组里的字段可写
   * `files[].path`（M2-d），不支持其它 JSONPath 语法。
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
    /**
     * 工具自己持有工作目录时，用它提供省略 `cwd` 后的真实执行目录。
     * 典型场景是跨 turn 的受控终端：它的目录来自 `shell.session.open`，不一定等于会话 cwd。
     * 网关会用这个值判权并回写入参，保证判定与执行不会落到两个目录。
     */
    readonly resolveCwd?: (input: unknown, ctx: ToolContext) => string | undefined;
  };

  /**
   * 哪些入参字段是**网络目的地**（M1-d，web.fetch 的 SSRF 判定）。与 `pathInputs` /
   * `commandInputs` 并列，同样不进 `ToolDescriptor`——模型不需要知道我们内部怎么解析它给的 URL。
   *
   * 声明了 `host` kind 的能力（`net.fetch` / `browser.control`）却不声明这个字段，
   * 网关会当场拒绝——与 `pathInputs`/`commandInputs` 缺失时同一个理由：不知道 URL 在哪个
   * 字段，就没法在判权前解析 DNS、按 IP 判内网段，这次调用会以一个空 target 通过所有
   * 基于目标的规则。
   */
  readonly hostInputs?: readonly string[];

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

  /**
   * 落库的最小事实的形状（ADR-0058）。**不声明它，工具 yield 出来的 `presentation`
   * 就不会落库**——展示数据同样是不可信输入，没有 schema 就没有校验，
   * 而一份没校验过的对象将来会原样喂给回放期的投影函数。
   */
  readonly presentationSchema?: z.ZodType<M>;

  /**
   * **规范输出值**的形状（`docs/10 §9.5.4`，ADR-0071）——这个工具交给**程序**的那份结构。
   *
   * 三件事必须同时成立，缺一条这个字段就没有意义：
   *
   * 1. **必须是 `z.strictObject()`**，`defineTool()` 当场拒绝标量与数组。理由是演进：
   *    往对象里加一个可选字段不破坏任何已有程序，把 `string` 改成对象则会。
   * 2. **必须落在与入参同一个可序列化子集里**（`assertToolSchema(..., 'output')`）。
   *    它要跨 QuickJS 客体域边界，能不能 JSON 化的约束一字不差。
   * 3. **不声明就不产出**：工具 yield 出来的 `output` 会被丢掉，失败关闭，
   *    与 `presentationSchema` 同形同理。
   *
   * ⚠️ **不进 `ToolDescriptor`。** 模型看的是 `forModel` 那份散文，不需要知道程序拿到的是
   * 什么形状——描述符的每个字段都要进提示词、占 token。需要它的是 M3-h 的 SDK 生成，
   * 而那发生在主进程里，手上有的是 `ToolSpec` 本身。
   */
  readonly outputSchema?: z.ZodType<O>;

  /**
   * 挂起卡片：工具刚开始跑时显示什么。**纯函数**——禁 I/O、禁读会话状态、禁时钟随机。
   *
   * 它与 `presentResult` 在实时流与日志回放两条路上都要跑。一个会读盘的 `presentCall`
   * 就是第二份会漂移的状态：实时流里读到 A，三天后的回放里读到 B（ADR-0021 的同一条不变量）。
   *
   * 抛异常或产出不合契约的形状**一律降级为通用卡片**，绝不让回放崩掉。
   */
  presentCall?(input: NoInfer<I>): ToolCard | undefined;

  /** 完成卡片。同样是纯函数，输入全部来自已落库的事实（见 `ToolResultOutcome`） */
  presentResult?(input: NoInfer<I>, outcome: ToolResultOutcome<M>): ToolCard | undefined;

  /**
   * 卡片上可以点的动作（ADR-0065）。键即 `actionId`。
   *
   * 它**不进 `ToolDescriptor`**——与 `pathInputs` / `commandInputs` 同理：模型不需要
   * 知道用户界面上有什么按钮，而描述符的每个字段都要进提示词、占 token。
   * 渲染层拿到的是卡片里的 `actions`（只有 id、名字与载荷种类），不是这份声明。
   */
  readonly actions?: Readonly<Record<string, ToolActionSpec<NoInfer<I>, NoInfer<M>>>>;
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
  /** 见 `ToolSpec.hostInputs`。空数组表示"这个工具没有网络目的地入参" */
  readonly hostInputs: readonly string[];
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
  /**
   * 卡片投影，**已经软化过**：入参不合 schema、投影抛异常、产出形状不合契约，
   * 三种情况一律返回 `undefined`，由 `projectCallCard` / `projectResultCard` 降级成通用卡片。
   */
  presentCall(rawInput: unknown): ToolCard | undefined;
  presentResult(rawInput: unknown, outcome: ToolResultOutcome): ToolCard | undefined;
  /** 校验工具 yield 出来的展示事实。没声明 schema、或校验不过，一律 `undefined`（不落库） */
  parsePresentation(value: unknown): unknown;
  /**
   * 校验工具 yield 出来的规范输出值。没声明 schema、或校验不过，一律 `undefined`。
   *
   * 与 `parsePresentation` 的差别只有**在哪一步调用**：展示事实要活到落库那一刻，
   * 所以它在 `record('tool.end')` 前才过 schema；规范值永远不进事件流，
   * 于是工具 yield 出来的那一刻就是它唯一的关口——过了这里它就直接交给程序了。
   */
  parseOutput(value: unknown): unknown;
  /**
   * 规范输出值的 schema 原件，缺席表示这个工具不产出规范值。
   *
   * 留着它是为了 M3-h 的 SDK 生成要 `z.toJSONSchema()`，以及 `pnpm generate:docs`
   * 要把顶层字段列进工具目录——两者都在主进程里跑，用不着跨进程的描述符。
   */
  readonly outputSchema?: z.ZodType;
  readonly actions: Readonly<Record<string, ToolActionSpec<unknown, unknown>>>;
}
