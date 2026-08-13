import type { OsFamily, ToolAvailabilityContext, ToolRegistry } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

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
