import type { ModelRequest } from '@xm/contracts';
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

export function turnAvailabilityContext(
  input: TurnRequestInput,
): ToolAvailabilityContext | undefined {
  return input.toolAvailability === undefined
    ? undefined
    : { ...input.toolAvailability, cwd: input.runtime.state.cwd };
}

/** Request construction is independent from streaming, dispatch and execution. */
export function buildTurnRequest(input: TurnRequestInput): ModelRequest {
  const availability = turnAvailabilityContext(input);
  const host = input.hostOs ?? '当前主机';
  const tools = input.tools.descriptors(availability);
  const todoGuidance = tools.some((tool) => tool.name === 'todo.update')
    ? `\n预计需要至少三个实质步骤时，用 todo.update 维护简短清单并随进展更新；简单任务不要创建清单。`
    : '';
  return {
    model: input.model,
    system: [
      {
        cacheable: true,
        text:
          `你是小明，本地自主通用 Agent。目标是实际完成用户任务。\n` +
          `已知运行平台：${host}；当前工作目录：${input.runtime.state.cwd}。不要重复探测这些信息。\n` +
          `执行型任务应优先执行：先完成用户明确要求的最小可用结果，再验证；除非用户要求，不自行扩展功能。\n` +
          `避免在思考中完整起草大段文件内容，应通过可用工具直接写入。只有完成或明确受阻时才结束回合。` +
          todoGuidance,
      },
    ],
    messages: [...input.runtime.state.messages],
    tools,
    maxOutputTokens: Math.min(
      MAIN_MAX_OUTPUT_TOKENS,
      input.providerMaxOutputTokens ?? MAIN_MAX_OUTPUT_TOKENS,
    ),
  };
}
