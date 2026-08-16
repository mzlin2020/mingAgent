import type { CallId, Message, XmError } from '@xm/contracts';
import type { CodeDispatchView } from '../../shared/code-dispatch.js';

/**
 * 右栏详情的材料。两种形状，没有第三种。
 *
 * · `native`：模型发起的调用。入参与结果都在 `reduce()` 出来的 `messages` 里
 *   （`tool_use` / `tool_result`），与 ADR-0065「由 callId 反查」查的是同一份状态。
 * · `dispatch`：Code Mode 子调用。`reduce()` 对 `tool.code.dispatch` 只推进 lastSeq
 *   （ADR-0072），所以这份来自打开会话时按类型过滤的一次读 + 之后的事件增量，
 *   与 `extRecords` 同一姿势（ADR-0057），**不进 SessionState**。
 *
 * Output 对 dispatch **没有结果正文可放**——payload 里没有 `forModel`。
 */
export type CallMaterial =
  | {
      readonly kind: 'native';
      readonly callId: CallId;
      readonly name: string;
      readonly input: unknown;
      readonly output: NativeOutput | undefined;
    }
  | {
      readonly kind: 'dispatch';
      readonly callId: CallId;
      readonly parentCallId: CallId;
      readonly index: number;
      readonly name: string;
      readonly input: unknown;
      readonly ok: boolean;
      readonly durationMs: number;
      readonly error: XmError | undefined;
    };

export interface NativeOutput {
  readonly text: string;
  readonly isError: boolean;
}

export type DetailsTab = 'details' | 'workspace';

/**
 * 关闭 = 零宽，滚动宿主保持挂载（ADR-0074 §三）。
 *
 * 返回值不取决于 `collapsed`：关掉栏位不能换一个新节点，否则滚动位置和
 * 工作区四块的展开状态都会丢。把这个函数改成 `collapsed ? 'gone' : 'mounted'`
 * 时，下面的用例必须红。
 */
export function detailsScrollHost(collapsed: boolean): 'mounted' {
  void collapsed;
  return 'mounted';
}

/** 子调用详情 Output 段的固定说明。改文案可以，但不得改成「数据缺失」。 */
export const DISPATCH_OUTPUT_NOTICE =
  '子调用的结果正文本就未落库（程序中间值不进模型请求），这里不是数据缺失。';

export function lookupCallMaterial(
  messages: readonly Message[],
  dispatches: ReadonlyMap<CallId, CodeDispatchView>,
  callId: CallId,
): CallMaterial | undefined {
  const dispatch = dispatches.get(callId);
  if (dispatch !== undefined) {
    return {
      kind: 'dispatch',
      callId: dispatch.callId,
      parentCallId: dispatch.parentCallId,
      index: dispatch.index,
      name: dispatch.name,
      input: dispatch.input,
      ok: dispatch.ok,
      durationMs: dispatch.durationMs,
      error: dispatch.error,
    };
  }

  let name: string | undefined;
  let input: unknown;
  let output: NativeOutput | undefined;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.id === callId) {
        name = block.name;
        input = block.input;
      }
      if (block.type === 'tool_result' && block.toolUseId === callId) {
        output = {
          text: nativeOutputText(block.content),
          isError: block.isError,
        };
      }
    }
  }
  if (name === undefined) return undefined;
  return { kind: 'native', callId, name, input, output };
}

export function childDispatches(
  dispatches: ReadonlyMap<CallId, CodeDispatchView>,
  parentCallId: CallId,
): readonly CodeDispatchView[] {
  const out: CodeDispatchView[] = [];
  for (const item of dispatches.values()) {
    if (item.parentCallId === parentCallId) out.push(item);
  }
  return out.sort((a, b) => a.index - b.index);
}

export function formatInputJson(input: unknown): string {
  try {
    const text = JSON.stringify(input, null, 2);
    return typeof text === 'string' ? text : String(input);
  } catch {
    return String(input);
  }
}

export function formatDispatchOutput(material: Extract<CallMaterial, { kind: 'dispatch' }>): {
  readonly body: string;
  readonly notice: string;
} {
  return {
    body: material.ok ? '已执行' : (material.error?.message ?? '失败'),
    notice: DISPATCH_OUTPUT_NOTICE,
  };
}

export function nextDetailsTab(
  prevSelected: CallId | undefined,
  nextSelected: CallId | undefined,
  currentTab: DetailsTab,
): DetailsTab {
  if (nextSelected === undefined) return 'workspace';
  if (nextSelected !== prevSelected) return 'details';
  return currentTab;
}

export function shouldOpenDetailsOnSelect(
  prevSelected: CallId | undefined,
  nextSelected: CallId | undefined,
  openPref: boolean,
): boolean {
  return nextSelected !== undefined && nextSelected !== prevSelected && !openPref;
}

export function countNativeToolCalls(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use') count += 1;
    }
  }
  return count;
}

export function shouldShowDetailsColumn(input: {
  readonly hasWorkspaceBlocks: boolean;
  readonly selected: boolean;
  readonly nativeCalls: number;
  readonly dispatchCount: number;
}): boolean {
  return (
    input.hasWorkspaceBlocks ||
    input.selected ||
    input.nativeCalls > 0 ||
    input.dispatchCount > 0
  );
}

function nativeOutputText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .map((block) => (block.type === 'text' && block.text !== undefined ? block.text : `[${block.type}]`))
    .join('\n');
}
