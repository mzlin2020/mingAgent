import type { ModelChunk, ModelRequest } from '@xm/contracts';

/**
 * 模型提供商端口（把 docs/04 §4.1 的草案落成实现级接口）。
 *
 * 三条从草案里继承下来、必须写死的规定：
 *
 * **一、只有流式。** 不提供 `complete()`。非流式接口一旦存在，就一定会有调用点图省事
 * 用它，而"用户点停止要在 200ms 内真停"（docs/04 §7）在非流式路径上做不到。
 *
 * **二、能力自描述。** 内核据 `capabilities()` 决定是否走并行工具、是否附图、
 * 是否插缓存断点。写死"Anthropic 支持思考"这种判断，等于把 Provider 差异漏回内核。
 *
 * **三、`ModelRequest` 是中立结构。** 各家的差异（Anthropic 的 system 独立、
 * OpenAI 的 developer 角色、思考块回传的签名）全部在适配器里消化，不上浮。
 *
 * 成本也不在这里算：`ModelChunk` 只带 token 数，`costUsd` 由查价格表得出——
 * 价格是配置，硬编码进适配器就等于每次调价都要发版（见 contracts/model/usage.ts）。
 */

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly parallelTools: boolean;
  readonly vision: boolean;
  readonly documents: boolean;
  readonly thinking: boolean;
  readonly promptCache: boolean;
  readonly maxContext: number;
  readonly maxOutput: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
}

/**
 * `AbortSignal` 的结构化最小面。
 *
 * 内核的 `lib` 只有 ES2023、`types` 是空数组（见 tsconfig.base.json），所以 `AbortSignal`
 * 这个名字在内核里根本不存在。把 `"DOM"` 加进 lib 能让它出现，但同时会把 `fetch`、
 * `localStorage` 一并带进来——"内核零 I/O"的编译期保证就是这么一点点漏掉的。
 *
 * 真实的 `AbortSignal` 结构上满足这个接口，调用方直接传即可。
 */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ModelProvider {
  /** 稳定标识，如 `"anthropic"`。进事件与配置，不要改 */
  readonly id: string;

  listModels(): Promise<readonly ModelInfo[]>;

  /**
   * 同步返回：内核在装配上下文的过程中要连问好几次（要不要附图、能不能并行工具），
   * 那条路径上不该有 await。适配器把结果缓存在内存里即可。
   */
  capabilities(model: string): ModelCapabilities;

  stream(req: ModelRequest, signal: CancelSignal): AsyncIterable<ModelChunk>;

  /** 可选：能精确计数的家提供，其余由内核用估算器兜底 */
  countTokens?(req: ModelRequest): Promise<number>;
}
