import { describe, expect, it } from 'vitest';
import {
  EventEnvelope,
  NoticePayload,
  XmEvent,
  newEventId,
  newSessionId,
  parseStoredEvent,
} from '@xm/contracts';

/**
 * 事件宽松性 —— docs/10 §12 验收项。
 *
 * 这组测试守的是**一个具体的事故**：有人为了"一致性"把事件 payload 从
 * `z.looseObject()` 改成 `z.object()`。Zod 的 `z.object()` 是 strip 模式，
 * 会静默丢弃未知字段——不报错、不告警。在事件流里，未知字段意味着版本漂移
 * （新版本写的、旧版本读的），丢掉它等于**永久损坏历史数据**。
 *
 * 这类破坏不会有任何红色输出，只有这几个断言能拦住。
 */
describe('事件 payload 必须保留未知字段', () => {
  const base = {
    id: newEventId(),
    sessionId: newSessionId(),
    seq: 1,
    ts: 1_754_300_000_000,
    v: 1,
  };

  it('payload 里的未知字段在 parse 后仍然存在', () => {
    const parsed = parseStoredEvent({
      ...base,
      type: 'notice.posted',
      payload: { level: 'info', code: 'x', message: 'hi', fieldFromFutureVersion: 42 },
    });

    expect(parsed.payload).toMatchObject({ fieldFromFutureVersion: 42 });
  });

  it('信封层的未知字段同样保留', () => {
    const parsed = parseStoredEvent({
      ...base,
      type: 'notice.posted',
      payload: { level: 'info', code: 'x', message: 'hi' },
      envelopeFieldFromFutureVersion: 'keep-me',
    });

    expect(parsed).toMatchObject({ envelopeFieldFromFutureVersion: 'keep-me' });
  });

  it('嵌套对象里的未知字段也保留', () => {
    const parsed = NoticePayload.parse({
      level: 'warn',
      code: 'c',
      message: 'm',
      nested: { deep: { unknown: true } },
    });
    expect(parsed).toMatchObject({ nested: { deep: { unknown: true } } });
  });

  it('宽松不等于不校验：字段类型错了照样拒绝', () => {
    expect(() => NoticePayload.parse({ level: 'nope', code: 'c', message: 'm' })).toThrow();
    expect(() => NoticePayload.parse({ level: 'info', code: 1, message: 'm' })).toThrow();
  });

  it('判别联合在 looseObject 下仍能正确判别，且未知判别值被拒', () => {
    const ok = XmEvent.parse({
      ...base,
      type: 'session.title',
      payload: { title: '标题', extra: 1 },
    });
    expect(ok.type).toBe('session.title');

    expect(() => XmEvent.parse({ ...base, type: 'not.a.real.event', payload: {} })).toThrow();
  });

  it('未知事件类型显式失败，而不是被静默忽略', () => {
    expect(() => parseStoredEvent({ ...base, type: 'future.event', payload: {} })).toThrow(
      /未知事件类型/,
    );
  });

  it('ext.* 事件走旁路：核心不校验其 payload，原样保留', () => {
    const parsed = parseStoredEvent({
      ...base,
      type: 'ext.my-plugin.tick',
      payload: { whatever: [1, 2, 3] },
    });
    expect(parsed.payload).toEqual({ whatever: [1, 2, 3] });
  });

  it('信封缺省 v 时补 1', () => {
    const parsed = EventEnvelope.parse({
      id: newEventId(),
      sessionId: newSessionId(),
      seq: 3,
      ts: 1,
      type: 'notice.posted',
      payload: {},
    });
    expect(parsed.v).toBe(1);
  });

  it('seq 必须是正整数', () => {
    const bad = { ...base, seq: 0, type: 'notice.posted', payload: { level: 'info', code: 'c', message: 'm' } };
    expect(() => parseStoredEvent(bad)).toThrow();
  });
});
