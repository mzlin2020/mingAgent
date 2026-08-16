import type { OsFamily, ToolAvailabilityContext, ToolRegistry } from '@xm/kernel';
import { RUN_CODE } from './code-sdk.js';
import type { SessionRuntime } from './session-runtime.js';

export type ToolPresentation = 'native' | 'code' | 'both';

/** 缺席即 `native`。Code Mode 是 opt-in（ADR-0061 §二） */
export const presentationOf = (input: {
  readonly toolPresentation?: ToolPresentation;
}): ToolPresentation => input.toolPresentation ?? 'native';

/**
 * 这个工具进不进**模型视野**（ADR-0061 §二）。
 *
 * ⚠️ 它管的只是模型那一侧。程序发起的子调用不经过这里——`code` 模式下要是也拦，
 * Code Mode 自己就没工具可调了。
 *
 * `code` 模式下模型点名别的工具会得到"没有这个工具"，而且是**在判定之前**：
 * 那不是一次被拒绝的调用，是一次不存在的调用。两者在事件流里长得不一样，
 * 而这正是我们要的——被拒绝意味着"你想做的事不被允许"，
 * 不存在意味着"你记错了自己有什么"。
 */
export const isModelVisible = (presentation: ToolPresentation, name: string): boolean => {
  if (presentation === 'both') return true;
  return presentation === 'code' ? name === RUN_CODE : name !== RUN_CODE;
};

export interface TurnRequestInput {
  readonly runtime: SessionRuntime;
  readonly tools: ToolRegistry;
  readonly model: string;
  readonly hostOs?: OsFamily;
  readonly toolAvailability?: Omit<ToolAvailabilityContext, 'cwd'>;
  /** Provider 能力表声明的输出上限；主回合仍会再施加自己的上限。 */
  readonly providerMaxOutputTokens?: number;
}

/** 主回合要容纳完整代码回答，但不能把异常生成放大到 128K。 */
export const MAIN_MAX_OUTPUT_TOKENS = 16_384;

/**
 * 真正可声明为 prompt-cache 稳定前缀的唯一文本。
 *
 * cwd、平台和动态工具提示刻意不在这里；ContextBuilder 会把它们放进后续非缓存段。
 */
export const STABLE_SYSTEM_PROMPT =
  `你是小明，本地自主通用 Agent。目标是实际完成用户任务。\n` +
  `执行型任务应优先执行：先完成用户明确要求的最小可用结果，再验证；除非用户要求，不自行扩展功能。\n` +
  `避免在思考中完整起草大段文件内容，应通过可用工具直接写入。只有完成或明确受阻时才结束回合。`;

export function turnAvailabilityContext(
  input: TurnRequestInput,
): ToolAvailabilityContext | undefined {
  return input.toolAvailability === undefined
    ? undefined
    : { ...input.toolAvailability, cwd: input.runtime.state.cwd };
}

export function mainMaxOutputTokens(input: {
  readonly maxContext: number;
  readonly providerMaxOutputTokens?: number;
}): number {
  // 极小上下文模型不能把全部窗口都声明为输出；至少给输入留 80%。
  const contextShare = Math.max(1, Math.floor(input.maxContext * 0.2));
  return Math.min(
    MAIN_MAX_OUTPUT_TOKENS,
    input.providerMaxOutputTokens ?? MAIN_MAX_OUTPUT_TOKENS,
    contextShare,
  );
}
