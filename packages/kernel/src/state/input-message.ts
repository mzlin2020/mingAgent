import type { ContentBlock, MessageId } from '@xm/contracts';
import type { SessionState } from './session-state.js';

/** turn.start 与 context.injected 共用同一条“输入进入消息历史”投影。 */
export const appendInputMessage = (
  messages: SessionState['messages'],
  id: MessageId,
  blocks: readonly ContentBlock[],
  ts: number,
): SessionState['messages'] => [...messages, { id, role: 'user', blocks: [...blocks], ts }];

/**
 * `context.injected` 专用的投影（ADR-0064 §一）。
 *
 * 注入可以发生在**回合进行中**——子 Agent 回传就是这条路（ADR-0056 §四）。此时消息历史的
 * 末尾往往已经是一条 user 消息（上一步的 tool_result 桶），直接再追加一条就会产生两条相邻的
 * user 消息。Provider 那一侧要求角色严格交替、且 `tool_result` 必须紧跟在发起它的 assistant
 * 消息之后，两条相邻 user 消息会被直接拒绝（400）——**而这条错误在 ScriptedProvider 下完全
 * 看不见**，只有真实 Provider 才会红。
 *
 * 所以注入内容并进末尾那条 user 消息，而不是新起一条。语义没变：它仍然在自己的 seq 位置上
 * 进入模型视野，只是与同一步的输入合成同一条消息。`turn.start` 刻意不走这条路——回合切片
 * （ADR-0048）按 `turn.start` 时的消息条数记录起点，合并会把切片起点算错。
 */
export const appendInjectedMessage = (
  messages: SessionState['messages'],
  id: MessageId,
  blocks: readonly ContentBlock[],
  ts: number,
): SessionState['messages'] => {
  const last = messages.at(-1);
  if (last?.role !== 'user') return appendInputMessage(messages, id, blocks, ts);
  return [...messages.slice(0, -1), { ...last, blocks: [...last.blocks, ...blocks] }];
};
