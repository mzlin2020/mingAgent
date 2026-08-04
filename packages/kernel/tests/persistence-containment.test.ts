import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { XmEvent } from '@xm/contracts';
import { PERSISTED_EVENT_TYPES, isCoreEvent, parseStoredEvent } from '@xm/contracts';
import { emptySessionState, reduce, reduceAll } from '@xm/kernel';
import { sampleEvents } from './helpers/sample-events.js';

/**
 * 🔴 持久化包含性 —— ADR-0008 的硬不变量，也是本仓库最重要的一个测试。
 *
 * 不变量：*transient 事件不得携带 persisted 事件流中不存在的信息。*
 *
 * 为什么需要它：一次 1000 轮的长会话，token 级 delta 有百万量级。全部落库会让事件表
 * 膨胀两个数量级，reduce 与回放都被拖垮。所以 delta 不落库——但这只有在
 * "delta 不携带任何终态信息"时才成立。
 *
 * 这个测试是防止未来某人图省事把关键状态只放进 delta 的**唯一**屏障。
 * 它一旦失败，不要改测试，要改代码。
 */
const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/events/v1/basic-session.json', import.meta.url),
);

function loadFixture(): XmEvent[] {
  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown[];
  return rows.map((r) => parseStoredEvent(r)).filter(isCoreEvent);
}

const persistedOnly = (events: readonly XmEvent[]): XmEvent[] =>
  events.filter((e) => PERSISTED_EVENT_TYPES.includes(e.type));

describe('持久化包含性', () => {
  it('完整流 reduce 与 persisted-only reduce 结果完全相等（fixture 会话）', () => {
    const all = loadFixture();
    const persisted = persistedOnly(all);

    expect(persisted.length).toBeLessThan(all.length); // 确保 fixture 里真的有瞬态事件

    const fromAll = reduceAll(emptySessionState(all[0]!.sessionId), all);
    const fromPersisted = reduceAll(emptySessionState(all[0]!.sessionId), persisted);

    expect(fromPersisted).toEqual(fromAll);
  });

  it('完整流 reduce 与 persisted-only reduce 结果完全相等（全事件类型样本）', () => {
    const all = sampleEvents();
    const persisted = persistedOnly(all);

    expect(persisted.length).toBeLessThan(all.length);

    const fromAll = reduceAll(emptySessionState(all[0]!.sessionId), all);
    const fromPersisted = reduceAll(emptySessionState(all[0]!.sessionId), persisted);

    expect(fromPersisted).toEqual(fromAll);
  });

  it('每个瞬态事件单独作用于任意状态时都是恒等变换', () => {
    const all = sampleEvents();
    const midState = reduceAll(emptySessionState(all[0]!.sessionId), persistedOnly(all).slice(0, 8));

    for (const e of all.filter((x) => !PERSISTED_EVENT_TYPES.includes(x.type))) {
      // 连引用都不该变——新建对象意味着有人"顺手"复制了状态，
      // 下一个人就会在那里加一行赋值
      expect(reduce(midState, e), e.type).toBe(midState);
    }
  });

  it('瞬态事件不推进 lastSeq —— 否则持久化流就会出现空洞', () => {
    const all = sampleEvents();
    const fromAll = reduceAll(emptySessionState(all[0]!.sessionId), all);
    expect(fromAll.lastSeq).toBe(persistedOnly(all).length);
  });
});

describe('reduce 的完整性与纯净性', () => {
  it('每种事件类型都能被处理，不会掉进 never 分支', () => {
    const all = sampleEvents();
    let state = emptySessionState(all[0]!.sessionId);
    for (const e of all) {
      expect(() => {
        state = reduce(state, e);
      }, e.type).not.toThrow();
    }
  });

  it('reduce 不修改传入的状态（纯函数）', () => {
    const all = sampleEvents();
    const initial = emptySessionState(all[0]!.sessionId);
    const snapshot = structuredClone({ ...initial, runningCalls: [], runningSubagents: [] });

    reduceAll(initial, all);

    expect({ ...initial, runningCalls: [], runningSubagents: [] }).toEqual(snapshot);
  });

  it('同一段事件流 reduce 两次得到相同结果（确定性）', () => {
    const all = sampleEvents();
    const a = reduceAll(emptySessionState(all[0]!.sessionId), all);
    const b = reduceAll(emptySessionState(all[0]!.sessionId), all);
    expect(a).toEqual(b);
  });
});
