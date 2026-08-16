import { describe, expect, it } from 'vitest';
import {
  EVENT_SPECS,
  createEvent,
  newEventId,
  newSessionId,
  parseStoredEvent,
} from '@xm/contracts';

/**
 * 写入路径的护栏。
 *
 * 读取路径（parseStoredEvent）一开始就有校验、upcaster、未知类型报错；写入路径却是
 * "手工拼一个对象字面量"，`v` 全靠人记得填对。而事件一旦落库就是永久的：
 * `v` 写错会让日后的 upcaster 跑在错误的数据上，且要等到几个版本之后才暴露。
 */

const S = newSessionId();

describe('createEvent：写入侧的唯一入口', () => {
  it('🔴 v 由注册表决定，调用方无从插手', () => {
    const e = createEvent({
      type: 'session.renamed',
      sessionId: S,
      seq: 1,
      ts: 1,
      payload: { title: '你好' },
    });
    expect(e.v).toBe(EVENT_SPECS['session.renamed'].version);
  });

  it('🔴 payload 写坏了当场失败，而不是等到读回来', () => {
    expect(() =>
      createEvent({
        type: 'usage.recorded',
        sessionId: S,
        seq: 1,
        ts: 1,
        // costUsd 缺失
        payload: { turnId: S, provider: 'anthropic', model: 'm', usage: {} } as never,
      }),
    ).toThrow();
  });

  it('产出的事件能原样通过读取路径', () => {
    const e = createEvent({
      type: 'notice.posted',
      sessionId: S,
      seq: 3,
      ts: 2,
      payload: { level: 'warn', code: 'secret_store_degraded', message: '无钥匙串' },
    });
    expect(parseStoredEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
});

describe('版本漂移', () => {
  const future = (v: number): unknown => ({
    id: newEventId(),
    sessionId: S,
    seq: 1,
    ts: 1,
    type: 'session.renamed',
    v,
    payload: { title: 'x', 未来字段: 1 },
  });

  it('🔴 来自更新版本的事件必须显式失败，不能降级解释', () => {
    // 修复前：v=7 被静默改写成 v=1，payload 按 v1 的理解读进状态，全程无报错。
    // loose 保留未知字段只解决了"字段丢失"，解决不了"字段语义变了"。
    expect(() => parseStoredEvent(future(7))).toThrow(/高于本机支持/);
  });

  it('当前版本正常通过', () => {
    expect(() => parseStoredEvent(future(EVENT_SPECS['session.renamed'].version))).not.toThrow();
  });
});

describe('占用投影不得进事件流（M3.5-f）', () => {
  it('🔴 登记成 context.occupancy → 未知事件类型', () => {
    expect(() =>
      parseStoredEvent({
        id: newEventId(),
        sessionId: S,
        seq: 1,
        ts: 1,
        type: 'context.occupancy',
        v: 1,
        payload: {
          systemTokens: 1,
          toolsTokens: 1,
          conversationTokens: 1,
          totalTokens: 3,
          capacityTokens: 100,
        },
      }),
    ).toThrow(/未知事件类型 "context.occupancy"/);
  });
});
