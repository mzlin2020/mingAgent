import type { XmEvent } from '@xm/contracts';
import { isUntrustedContentSource } from '@xm/contracts';
import type { SessionState, UntrustedContext } from './session-state.js';

/**
 * 上下文污染标记 —— `PermissionRequest.trustLevel` 的唯一来源。
 *
 * ── 为什么标在 `tool.start` 而不是 `tool.end` ──
 *
 * 保守。`tool.start` 说明这次调用**已经放出去了**，而一次 `net.fetch` 完全可能
 * 先收到了响应体、再在处理阶段抛错——那时 `tool.end` 是失败，内容却已经在上下文里了。
 * 按 `tool.end{ok:true}` 标记会漏掉这一整类，而漏标的代价是注入防御静默失效。
 *
 * ── 为什么读 `capabilities` 而不是给工具加一个新字段 ──
 *
 * `tool.start` 的 payload 里本来就带着 `capabilities`（turn.ts 写入），所以污点是
 * **从已有的持久化事件里算出来的**：不动事件 schema、不用升版本、老会话回放即生效，
 * 而且工具只要如实声明 `net.fetch` 就自动被覆盖——没有第二个地方需要人记得去填。
 *
 * 加一个 `introducesUntrustedContent` 布尔字段是更直白的写法，也正是本项目反复栽跟头的
 * 那种写法：多一个可以忘记填的地方，就多一条会安静失效的防线。
 *
 * 已置上就不再变（粘性），理由见 SessionState.untrustedContext。
 *
 * ⚠️ 已知不覆盖的两条路，见 docs/09 G2 与 ADR-0033：MCP 工具若不声明 `net.fetch`
 * 就标不出来（挡在 ToolRegistry.register()）；子 Agent 的不可信标记不会传染回父会话
 * （挡在 SessionRuntime.record()）——两条都只落了失败关闭的闸门，真正的传播逻辑
 * 随各自的载体（M3 / M2）落地。
 */
export function taintOf(
  state: SessionState,
  e: Extract<XmEvent, { type: 'tool.start' }>,
): UntrustedContext | undefined {
  if (state.untrustedContext !== undefined) return state.untrustedContext;

  const via = e.payload.capabilities.find(isUntrustedContentSource);
  if (via === undefined) return undefined;

  return {
    callId: e.payload.callId,
    toolName: e.payload.name,
    viaCapability: via,
    since: e.ts,
  };
}
