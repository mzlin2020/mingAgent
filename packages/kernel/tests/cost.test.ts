import { describe, expect, it } from 'vitest';
import type { Usage } from '@xm/contracts';
import { costOf, lookupPrice } from '@xm/kernel';

/**
 * 成本核算。
 *
 * 核心那条是**「算不出来返回 undefined，不返回 0」**——把"不知道"显示成"没花钱"，
 * 用户拿到的是一个自信的错数字。
 */

const USAGE: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 100_000,
};

describe('costOf', () => {
  it('🔴 没有价格时返回 undefined，不是 0', () => {
    expect(costOf(USAGE, undefined)).toBeUndefined();
  });

  it('按每百万 token 计价', () => {
    const cost = costOf(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { input: 3, output: 15 },
    );
    expect(cost).toBe(3);
  });

  it('缓存价缺省时按 input 计 —— 不知道折扣时唯一不会低估的取法', () => {
    const price = { input: 3, output: 15 };
    // 1×3 + 0.5×15 + 2×3 + 0.1×3
    expect(costOf(USAGE, price)).toBeCloseTo(3 + 7.5 + 6 + 0.3, 10);
  });

  it('给了缓存价就用缓存价', () => {
    const cost = costOf(USAGE, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(cost).toBeCloseTo(3 + 7.5 + 0.6 + 0.375, 10);
  });

  it('零用量算出 0 —— 这个 0 与"不知道"是两回事', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf(zero, { input: 3, output: 15 })).toBe(0);
    expect(costOf(zero, undefined)).toBeUndefined();
  });
});

describe('lookupPrice', () => {
  const table = { 'anthropic/claude-opus-5': { input: 1, output: 2 } };

  it('按 provider/model 组合查', () => {
    expect(lookupPrice(table, 'anthropic', 'claude-opus-5')).toEqual({ input: 1, output: 2 });
  });

  it('🔴 同名模型在不同 provider 下不串价 —— 兼容端点的价格与官方端点可以完全不同', () => {
    expect(lookupPrice(table, 'my-proxy', 'claude-opus-5')).toBeUndefined();
  });

  it('没有价格表时不炸', () => {
    expect(lookupPrice(undefined, 'anthropic', 'claude-opus-5')).toBeUndefined();
  });
});
