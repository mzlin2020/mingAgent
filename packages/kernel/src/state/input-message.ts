import type { ContentBlock, MessageId } from '@xm/contracts';
import type { SessionState } from './session-state.js';

/** turn.start 与 context.injected 共用同一条“输入进入消息历史”投影。 */
export const appendInputMessage = (
  messages: SessionState['messages'],
  id: MessageId,
  blocks: readonly ContentBlock[],
  ts: number,
): SessionState['messages'] => [...messages, { id, role: 'user', blocks: [...blocks], ts }];
