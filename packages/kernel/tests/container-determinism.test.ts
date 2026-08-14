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
import {
  PluginContainer,
  createDeterministicClock,
  createDeterministicIds,
} from '@xm/kernel';
import type { CoreContainerServices } from '@xm/kernel';

describe('容器基线服务：确定性时钟与 ID', () => {
  it('时钟从固定起点按步进推进，并支持显式 advance', () => {
    const clock = createDeterministicClock({ start: 1_000, step: 5 });

    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_005);
    clock.advance(40);
    expect(clock.now()).toBe(1_050);
  });

  it('所有 ID 工厂共享一条递增序列，且产物仍是合法 UUIDv4', () => {
    const ids = createDeterministicIds(1);
    const values = [
      ids.session(),
      ids.event(),
      ids.turn(),
      ids.message(),
      ids.call(),
      ids.request(),
      ids.agent(),
      ids.checkpoint(),
      ids.editProposal(),
      ids.ptySession(),
    ];

    expect(values).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000007',
      '00000000-0000-4000-8000-000000000008',
      '00000000-0000-4000-8000-000000000009',
      '00000000-0000-4000-8000-00000000000a',
    ]);
    expect(SessionId.safeParse(values[0]).success).toBe(true);
    expect(EventId.safeParse(values[1]).success).toBe(true);
    expect(TurnId.safeParse(values[2]).success).toBe(true);
    expect(MessageId.safeParse(values[3]).success).toBe(true);
    expect(CallId.safeParse(values[4]).success).toBe(true);
    expect(RequestId.safeParse(values[5]).success).toBe(true);
    expect(AgentId.safeParse(values[6]).success).toBe(true);
    expect(CheckpointId.safeParse(values[7]).success).toBe(true);
    expect(EditProposalId.safeParse(values[8]).success).toBe(true);
    expect(PtySessionId.safeParse(values[9]).success).toBe(true);
  });

  it('非法时钟参数和超出 UUID 尾段的序列在入口失败', () => {
    expect(() => createDeterministicClock({ start: Number.NaN, step: 1 })).toThrow(/start/);
    expect(() => createDeterministicClock({ start: 0, step: -1 })).toThrow(/step/);
    expect(() => createDeterministicIds(-1)).toThrow(/start/);
  });

  it('服务通过稳定的 ctx.clock / ctx.ids 属性读取', () => {
    const container = new PluginContainer<CoreContainerServices>();
    container.provide('clock', createDeterministicClock({ start: 20, step: 1 }));
    container.provide('ids', createDeterministicIds(20));

    expect(container.context.clock.now()).toBe(20);
    expect(container.context.ids.turn()).toBe('00000000-0000-4000-8000-000000000014');
  });
});
