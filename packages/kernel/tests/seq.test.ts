import { describe, expect, it } from 'vitest';
import type { XmEvent } from '@xm/contracts';
import { newEventId, newSessionId } from '@xm/contracts';
import { SeqInvariantError, assertSeqContiguous, nextSeq } from '@xm/kernel';

const sessionId = newSessionId();

const evt = (seq: number): XmEvent => ({
  id: newEventId(),
  sessionId,
  seq,
  ts: 1,
  type: 'notice',
  v: 1,
  payload: { level: 'info', code: 'c', message: 'm' },
});

describe('seq 不变量', () => {
  it('从 1 起连续递增是合法的', () => {
    expect(() => {
      assertSeqContiguous([evt(1), evt(2), evt(3)]);
    }).not.toThrow();
  });

  it('空流合法', () => {
    expect(() => {
      assertSeqContiguous([]);
    }).not.toThrow();
  });

  it('空洞被拒 —— 增量订阅靠"无空洞"才不需要额外元数据', () => {
    expect(() => {
      assertSeqContiguous([evt(1), evt(3)]);
    }).toThrow(SeqInvariantError);
    expect(() => {
      assertSeqContiguous([evt(1), evt(3)]);
    }).toThrow(/空洞/);
  });

  it('重复被拒 —— 多半意味着同一会话有第二个写者', () => {
    expect(() => {
      assertSeqContiguous([evt(1), evt(1)]);
    }).toThrow(/回退或重复/);
  });

  it('回退被拒', () => {
    expect(() => {
      assertSeqContiguous([evt(1), evt(2), evt(2)]);
    }).toThrow(SeqInvariantError);
  });

  it('不从 1 开始被拒（除非显式指定起点）', () => {
    expect(() => {
      assertSeqContiguous([evt(5)]);
    }).toThrow(SeqInvariantError);
    expect(() => {
      assertSeqContiguous([evt(5), evt(6)], 5);
    }).not.toThrow();
  });

  it('nextSeq 是写入侧唯一的分配入口', () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(15)).toBe(16);
  });
});
