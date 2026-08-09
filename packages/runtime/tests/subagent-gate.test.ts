import { describe, expect, it } from 'vitest';
import { newAgentId, newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore } from '@xm/kernel';
import { EventBus, SessionRuntime, UnimplementedSubagentTaintPropagationError } from '@xm/runtime';

/**
 * 子 Agent 污点传播闸门（ADR-0033 · G2）。
 *
 * 闸门挂在 `SessionRuntime.record()`——全系统唯一分配 seq 的写入边界——而不是
 * `reduce()`，所以这里直接构造一个 runtime 调 `record()`，不需要真实的子 Agent
 * 派生机制（M1 也确实没有）。
 */
describe('子 Agent 污点传播闸门（ADR-0033 · G2）', () => {
  it('🔴 subagent.start 记录时就炸', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    await expect(
      runtime.record({
        type: 'subagent.start',
        payload: {
          agentId: newAgentId(),
          childSessionId: newSessionId(),
          callId: newCallId(),
          purpose: '读一下这个网页',
        },
      }),
    ).rejects.toThrow(UnimplementedSubagentTaintPropagationError);
  });

  it('🔴 subagent.end 记录时就炸', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    await expect(
      runtime.record({
        type: 'subagent.end',
        payload: { agentId: newAgentId(), ok: true, summary: [] },
      }),
    ).rejects.toThrow(UnimplementedSubagentTaintPropagationError);
  });

  it('错误信息指向 ADR-0033，.eventType 与实际事件类型一致', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const runtime = await SessionRuntime.open({ sessionId: newSessionId(), store, bus });
    await runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } });

    try {
      await runtime.record({
        type: 'subagent.start',
        payload: {
          agentId: newAgentId(),
          childSessionId: newSessionId(),
          callId: newCallId(),
          purpose: 'x',
        },
      });
      expect.unreachable('应该抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(UnimplementedSubagentTaintPropagationError);
      expect((e as Error).message).toContain('ADR-0033');
      expect((e as UnimplementedSubagentTaintPropagationError).eventType).toBe('subagent.start');
    }
  });

  it('其他事件类型不受影响（闸门只挡这两种，不会误伤今天的真实代码）', async () => {
    const store = new MemoryEventStore();
    const bus = new EventBus();
    const runtime = await SessionRuntime.open({ sessionId: newSessionId(), store, bus });

    await expect(
      runtime.record({ type: 'session.created', payload: { cwd: '/w', modelRef: 'scripted/scripted-1' } }),
    ).resolves.toBeDefined();
    await expect(runtime.record({ type: 'session.renamed', payload: { title: '甲' } })).resolves.toBeDefined();
    expect(runtime.state.title).toBe('甲');
  });
});
