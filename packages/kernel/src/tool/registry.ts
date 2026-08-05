import type { ResourceClaim, ToolDescriptor, ToolProgress, XmError } from '@xm/contracts';
import { DEFAULT_RESULT_LIMITS, assertToolSchema, toModelSchema, xmError } from '@xm/contracts';
import type {
  RegisteredTool,
  ToolAvailabilityContext,
  ToolContext,
  ToolSpec,
} from './types.js';

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
      // 平台不具备该工具所需的任一能力 → 不暴露（ADR-0007）
      if (spec.capabilities.some((c) => !ctx.platformCapabilities.includes(c))) return false;
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
    this.#tools.set(name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
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
