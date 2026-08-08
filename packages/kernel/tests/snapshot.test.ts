import { describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import { deserializeSessionState, emptySessionState, reduceAll, serializeSessionState } from '@xm/kernel';
import { sampleEvents } from './helpers/sample-events.js';

/**
 * `serializeSessionState` / `deserializeSessionState` 的往返测试（ADR-0032，修 G4/G5）。
 *
 * 这一对函数存在的唯一理由是让快照能过 JSON/IPC——如果往返之后状态变了样，
 * 快照就成了一个悄悄损坏历史的 bug，比没有快照更糟（用户会看到一个"看起来对、
 * 实际不对"的会话）。用 `sampleEvents()` 而不是手写几个字段，是因为它覆盖了
 * 每一种事件类型，也就覆盖了 `SessionState` 的每一个字段——包括三个 `Map`
 * （`runningCalls`/`runningSubagents`/`ptySessions`），它们是唯二需要真正转换
 * （而不是原样引用）的字段。
 */
describe('serializeSessionState / deserializeSessionState 往返（ADR-0032）', () => {
  it('空状态往返后完全一致', () => {
    const id = newSessionId();
    const empty = emptySessionState(id);
    const back = deserializeSessionState(serializeSessionState(empty));
    expect(back).toEqual(empty);
  });

  it('🔴 覆盖全部事件类型的丰富状态往返后逐字段一致，包括三个 Map', () => {
    const id = newSessionId();
    /*
     * sampleEvents() 里每个 start 都配了一个 end/closed（它的职责是穷尽事件类型，
     * 不是留一个"活着"的状态），所以原样跑完三个 Map 全会清空。这里去掉三个
     * "收尾"事件，让 tool.start/subagent.start/shell.session.opened 留下的条目
     * 活到最后——往返测试要测的正是"Map 里还有东西时转换对不对"，用一个
     * 全空的 Map 测不出这个。sampleEvents() 用自己的 sessionId，这里只关心
     * reduce 出的状态形状，不关心是否与 id 一致——reduce 不校验 payload 里的 sessionId。
     */
    // `turn.end` 也要去掉：它会无条件把 runningCalls 搬进 interruptedCalls
    // 并清空前者（"回合结束时仍在跑的调用 = 被中断"，见 reduce.ts），
    // 同样会让这条测试想验证的 Map 变空。
    const events = sampleEvents().filter(
      (e) =>
        e.type !== 'tool.end' &&
        e.type !== 'subagent.end' &&
        e.type !== 'shell.session.closed' &&
        e.type !== 'turn.end',
    );
    const state = reduceAll(emptySessionState(id), events);

    // 往返前：至少真的用上了三个 Map，否则这条测试测不出"Map 没转换好"这类问题
    expect(state.runningCalls.size).toBeGreaterThan(0);
    expect(state.runningSubagents.size).toBeGreaterThan(0);
    expect(state.ptySessions.size).toBeGreaterThan(0);

    const serialized = serializeSessionState(state);
    const back = deserializeSessionState(serialized);

    expect(back).toEqual(state);
    // 显式再挨个查一遍三个 Map——`toEqual` 对 Map 的深比较已经够了，
    // 这里是留一条"如果以后有人把 Map 换成别的结构"也会失败的显式信号
    expect([...back.runningCalls.entries()]).toEqual([...state.runningCalls.entries()]);
    expect([...back.runningSubagents.entries()]).toEqual([...state.runningSubagents.entries()]);
    expect([...back.ptySessions.entries()]).toEqual([...state.ptySessions.entries()]);
  });

  it('序列化产出的是纯 JSON 安全值——过一趟 JSON.stringify/parse 不丢信息', () => {
    const id = newSessionId();
    const state = reduceAll(emptySessionState(id), sampleEvents());
    const serialized = serializeSessionState(state);

    const roundTripped = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
    const back = deserializeSessionState(roundTripped);

    expect(back).toEqual(state);
  });
});
