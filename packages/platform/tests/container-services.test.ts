import { describe, expect, it } from 'vitest';
import {
  AgentId,
  CallId,
  CheckpointId,
  EditProposalId,
  EventId,
  MessageId,
  PtySessionId,
  RequestId,
  SessionId,
  TurnId,
} from '@xm/contracts';
import { createLocalClock, createLocalIds } from '@xm/platform';

describe('生产 profile 的 local 时钟与 ID 提供者', () => {
  it('local clock 保持现有 epoch ms 行为', () => {
    const before = Date.now();
    const value = createLocalClock().now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('local ids 的每个入口都返回对应的合法 UUIDv4', () => {
    const ids = createLocalIds();
    expect(SessionId.safeParse(ids.session()).success).toBe(true);
    expect(EventId.safeParse(ids.event()).success).toBe(true);
    expect(TurnId.safeParse(ids.turn()).success).toBe(true);
    expect(MessageId.safeParse(ids.message()).success).toBe(true);
    expect(CallId.safeParse(ids.call()).success).toBe(true);
    expect(RequestId.safeParse(ids.request()).success).toBe(true);
    expect(AgentId.safeParse(ids.agent()).success).toBe(true);
    expect(CheckpointId.safeParse(ids.checkpoint()).success).toBe(true);
    expect(EditProposalId.safeParse(ids.editProposal()).success).toBe(true);
    expect(PtySessionId.safeParse(ids.ptySession()).success).toBe(true);
  });
});
