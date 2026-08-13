import type { ResourceClaim, ToolDescriptor, ToolProgress, XmError } from '@xm/contracts';
import { DEFAULT_RESULT_LIMITS, assertToolSchema, toModelSchema, xmError } from '@xm/contracts';
import type {
  RegisteredTool,
  ToolAvailabilityContext,
  ToolContext,
  ToolSpec,
} from './types.js';

/**
 * 声明空能力集（`capabilities: []`）的工具白名单，键是工具名，值是批准它这么做的
 * ADR 编号（ADR-0032 #5）。
 *
 * ── 为什么这是一件需要专门拦一道的事 ──
 *
 * `evaluate()` 判的是 claim，而 claim 由能力产出——声明空能力集的工具**结构性地
 * 不经过权限闸门**，红线与用户自己写的 deny 都碰不到它一根手指。这与原则四的
 * 约束"所有产生副作用的工具必须声明 capabilities 与 risk，并经过权限闸门"字面
 * 冲突；原则四本身也写了"任何'绕过审批'的代码路径都要有 ADR 说明"，`shell.session`
 * 的三个工具就是这样一份说明（ADR-0031）。**问题是这条纪律此前完全靠人记得住**——
 * 没有任何机制会在下一个想抄近道的新工具声明 `capabilities: []` 时发出信号，
 * 要求它必须先有一份 ADR。地基复审三（ADR-0032）把这一点点破：不允许"字面上
 * 不算违反"只靠没人滥用来维持，得让它变成机器能拦下来的东西。
 *
 * ── 为什么白名单在这里（`defineTool()`），不是一份独立的 lint 规则 ──
 *
 * `assertToolSchema()` 已经确立了"注册时就炸，而不是等模型在生产里填出一个诡异
 * 参数"（ADR-0009）这条先例——离风险最近的地方拦，而不是指望有人记得跑一个
 * 独立的静态扫描脚本。工具是不是声明了空能力集，`defineTool()` 本来就在看
 * （`spec.capabilities`），加一道检查不需要新的基础设施。
 */
export const EMPTY_CAPABILITIES_ALLOWLIST: Readonly<Record<string, string>> = {
  'agent.explore': 'ADR-0049（元工具只编排隔离子会话；实际只读访问仍由子工具逐次判权）',
  'result.expand': 'ADR-0042（只展开当前会话 tool.end.fullRef 已授权可达的工具结果）',
  'todo.update': 'ADR-0041（只更新当前会话内的可见任务清单，没有会话外副作用）',
  'shell.session.status': 'ADR-0040（只读查询当前会话所属终端的有界状态）',
  'shell.session.resize': 'ADR-0040（只改变当前会话所属终端显示尺寸）',
  'shell.session.close': 'ADR-0040（只关闭当前会话所属终端）',
  /*
   * `demo.echo` 是这条纪律建立之前就存在的一个更早的例子（M0-b，`packages/
   * runtime/src/tools/demo.ts`）——本轮复审 ADR-0032 说"全项目只有 PTY 的三个
   * 工具用到 capabilities: []，没有扩散"，写这条白名单实现时才发现这句话不准确，
   * 如实改正。**它与 shell.session 三个工具性质不同，不需要一份新 ADR**：
   * `demo.echo` 单纯把入参文本原样回显，没有任何副作用可言——原则四要求
   * "所有产生副作用的工具必须声明 capabilities"，一个真的不产生副作用的工具
   * 声明空能力集不是绕过闸门，是如实反映"这里没有什么好判的"。它确实被注册进了
   * 桌面应用（`apps/desktop/src/main/services.ts`），不只是测试专用，因此仍然
   * 要登记在这里，只是登记理由与 ADR 编号不同，写清楚以免和真正的安全例外混淆。
   */
  'demo.echo': '无 ADR——零副作用玩具工具（M0-b 冒烟用），非安全例外，与 shell.session 性质不同',
  /*
   * 以下两条是测试夹具，不是真实工具，登记理由与上面两类都不同：它们的存在
   * 只是为了让测试能构造出"一个声明了空能力集的工具"这个样本，用来验证
   * 网关/上下文隔离的某个行为，样本本身从不会被真正注册进任何一个运行中的应用。
   */
  'fs.probe': 'test-fixture（packages/tools-core/tests/gateway.test.ts）',
  'demo.spy': 'test-fixture（packages/runtime/tests/untrusted-clear.test.ts）',
};

/** 工具声明了空能力集，但没有登记在 `EMPTY_CAPABILITIES_ALLOWLIST` 里。 */
export class UnlistedEmptyCapabilitiesError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `工具 "${toolName}" 声明了空能力集（capabilities: []），意味着它的每次调用完全` +
        `不经过权限闸门——红线与用户自己写的 deny 规则都拦不住它（ADR-0032 #5）。` +
        `如果这是有意为之，必须先写一份 ADR 说明为什么可以这样做，再把工具名和 ADR` +
        `编号加进 packages/kernel/src/tool/registry.ts 的 EMPTY_CAPABILITIES_ALLOWLIST。` +
        `如果只是手滑漏填了 capabilities，把它填上就好。`,
    );
    this.name = 'UnlistedEmptyCapabilitiesError';
    this.toolName = toolName;
  }
}

/**
 * 工具来自 MCP，但污点传播尚未实现（ADR-0033 · G2）。
 *
 * `ToolDescriptor.source.kind === 'mcp'` 这个判别式早就在契约里了（`contracts/tool/descriptor.ts`），
 * 但没有任何代码读它——`taintOf()`（kernel/state/reduce.ts）只看 `capabilities`，一个不如实
 * 声明 `net.fetch` 的 MCP server 拉回来的内容不会被标记为不可信。而 MCP server 是第三方的，
 * 声明是否如实完全不受我们控制，这是 docs/09 G2 记的注入防御上"唯一剩下的绕过路径"。
 *
 * M1 没有 MCP 客户端，没有载体就无法用真实输入验证"MCP 工具默认按不可信内容源处理"这条
 * 实现是否正确——这是 `trustLevel` 硬编码（ADR-0017）与 Windows 8.3 短文件名（ADR-0018）
 * 两次翻车的同一个形状：写了实现、测试全绿、真实输入下从未跑过。所以先在注册路径上
 * 失败关闭，真正的实现随 M3 的 MCP 客户端一起落地。
 */
export class UnimplementedMcpTaintPropagationError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `工具 "${toolName}" 来自 MCP（source.kind === 'mcp'），但污点传播尚未实现（ADR-0033 · G2）：` +
        `MCP server 是第三方的，不能假设它会如实声明 net.fetch 之类的能力，因此这里失败关闭。` +
        `按 docs/09 G2 的既定倾向，MCP 工具本该一律默认按不可信内容源处理——这需要 taintOf()` +
        `（kernel/state/reduce.ts）对 source.kind === 'mcp' 的工具无条件标记 untrustedContext，` +
        `而这段实现要等 M3 真正接入 MCP 客户端时才能在真实输入下验证。要让这个错误消失，去实现` +
        `那段逻辑并在这里删除这道闸门，不要绕过它。`,
    );
    this.name = 'UnimplementedMcpTaintPropagationError';
    this.toolName = toolName;
  }
}

/** 模型给出的入参没通过 strict 校验。会被转成 tool_result{isError:true} 回灌给模型。 */
export class ToolInputError extends Error {
  readonly toolName: string;
  readonly asXmError: XmError;

  constructor(toolName: string, detail: string) {
    super(`工具 ${toolName} 的入参不合法：${detail}`);
    this.name = 'ToolInputError';
    this.toolName = toolName;
    this.asXmError = xmError('invalid_input', `工具 ${toolName} 的入参不合法：${detail}`, {
      retryable: true,
      detail: { toolName },
    });
  }
}

/**
 * 把工具定义变成注册表条目：校验 schema 落在可序列化子集内，导出 JSON Schema，
 * 并把入参类型擦除掉。
 *
 * 泛型 `I` 的作用是把 `inputSchema: ZodType<I>` 与 `execute(input: I)` 绑在一起——
 * 写错了（schema 说是 string、execute 当 number 用）在定义处就编译失败。
 */
export function defineTool<I>(spec: ToolSpec<I>): RegisteredTool {
  // 注册时就炸，而不是等模型在生产里填出一个诡异参数（ADR-0009）
  assertToolSchema(spec.inputSchema);

  // 声明空能力集必须显式登记（ADR-0032 #5），同样是注册时就炸
  if (spec.capabilities.length === 0 && !(spec.name in EMPTY_CAPABILITIES_ALLOWLIST)) {
    throw new UnlistedEmptyCapabilitiesError(spec.name);
  }

  const descriptor: ToolDescriptor = {
    name: spec.name,
    group: spec.group,
    description: spec.description,
    inputSchema: toModelSchema(spec.inputSchema),
    risk: spec.risk,
    capabilities: [...spec.capabilities],
    // 声明不了资源的工具一律降级为 exclusive（ADR-0005）
    concurrency: spec.concurrency ?? (spec.resources === undefined ? 'exclusive' : 'parallel'),
    resultLimits: { ...DEFAULT_RESULT_LIMITS, ...spec.resultLimits },
    source: spec.source ?? { kind: 'builtin' },
  };

  const parse = (raw: unknown): I => {
    const result = spec.inputSchema.safeParse(raw);
    if (!result.success) {
      throw new ToolInputError(spec.name, formatIssues(result.error));
    }
    return result.data;
  };

  return {
    descriptor,
    inputSchema: spec.inputSchema,
    pathInputs: spec.pathInputs ?? [],
    ...(spec.commandInputs === undefined ? {} : { commandInputs: spec.commandInputs }),
    hostInputs: spec.hostInputs ?? [],
    parseInput: parse,
    // 这里仍然再 parse 一次，即便 turn.ts 已经先校验过：`execute` 是公开入口，
    // 不能假设每个调用方都记得先校验。允许的 schema 子集里 `.transform()` 被禁掉了，
    // 所以重复校验是幂等的，不会把已校验的值再变一次形。
    execute(rawInput: unknown, ctx: ToolContext): AsyncIterable<ToolProgress> {
      return spec.execute(parse(rawInput), ctx);
    },
    resources(rawInput: unknown): readonly ResourceClaim[] {
      return spec.resources?.(parse(rawInput)) ?? [];
    },
    available(ctx: ToolAvailabilityContext): boolean {
      // 配置里禁用的工具一律不可用，且这条**优先于**工具自己的判断——
      // 用户关掉一个工具的意思是关掉，不是"由工具自己决定要不要听"
      if (ctx.disabledTools.includes(spec.name)) return false;
      return spec.available?.(ctx) ?? true;
    },
  };
}

/**
 * 工具注册表。**纯内存、无 I/O**——工具的来源（内置 / 插件 / MCP）由上层装配，
 * 注册表只认 RegisteredTool。
 */
export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const name = tool.descriptor.name;
    if (this.#tools.has(name)) {
      throw new Error(
        `工具名冲突："${name}" 已被注册。工具名在整个进程内唯一——` +
          `插件与 MCP 工具应带自己的前缀以避免撞名。`,
      );
    }
    // MCP 工具的污点传播尚未实现，注册时就炸（ADR-0033 · G2）。放在 register() 而不是
    // defineTool()：这里是任何 RegisteredTool（不管是手写 ToolSpec 还是未来动态发现的
    // MCP 工具描述符）最终都必须经过的唯一入口，defineTool() 只覆盖前一种构造路径。
    if (tool.descriptor.source.kind === 'mcp') {
      throw new UnimplementedMcpTaintPropagationError(name);
    }
    this.#tools.set(name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  /** 分发阶段再次检查可用性，不能只靠“没放进提示词”。 */
  getAvailable(name: string, ctx: ToolAvailabilityContext): RegisteredTool | undefined {
    const tool = this.#tools.get(name);
    return tool?.available(ctx) === true ? tool : undefined;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * 给模型看的工具列表。
   *
   * 不传 `ctx` = 全量；传了则按 `available()` 过滤（无 git 仓库不暴露 git 工具、
   * Linux 上不暴露 computer 工具……）。
   *
   * ⚠️ ADR-0006 的派生约束：动态过滤的结果**不得进入稳定前缀**。
   * 若这个列表逐轮变化，`ModelRequest.cacheBreakpointAfterMessage` 必须置于
   * 变化点之后，否则 prompt cache 每轮全部失效。
   */
  descriptors(ctx?: ToolAvailabilityContext): ToolDescriptor[] {
    const all = [...this.#tools.values()];
    const visible = ctx === undefined ? all : all.filter((t) => t.available(ctx));
    return visible.map((t) => t.descriptor);
  }

  get size(): number {
    return this.#tools.size;
  }
}

function formatIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => {
      const path = i.path.map(String).join('.');
      return path === '' ? i.message : `${path}: ${i.message}`;
    })
    .join('；');
}
