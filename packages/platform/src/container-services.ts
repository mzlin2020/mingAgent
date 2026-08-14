import {
  newAgentId,
  newCallId,
  newCheckpointId,
  newEditProposalId,
  newEventId,
  newMessageId,
  newPtySessionId,
  newRequestId,
  newSessionId,
  newTurnId,
} from '@xm/contracts';
import type { ClockService, IdService } from '@xm/kernel';

/** 生产 profile 的本机时钟。外部世界输入留在 platform，不进入纯 kernel。 */
export const createLocalClock = (): ClockService => ({ now: () => Date.now() });

/** 生产 profile 的 UUIDv4 工厂，行为与 M0–M2 的逐类型构造器一致。 */
export const createLocalIds = (): IdService => ({
  session: newSessionId,
  event: newEventId,
  turn: newTurnId,
  message: newMessageId,
  call: newCallId,
  request: newRequestId,
  agent: newAgentId,
  checkpoint: newCheckpointId,
  editProposal: newEditProposalId,
  ptySession: newPtySessionId,
});
