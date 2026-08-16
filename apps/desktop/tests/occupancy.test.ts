import { describe, expect, it } from 'vitest';
import {
  formatTokenCount,
  occupancyFillRatio,
  occupancyOverCapacity,
} from '../src/renderer/lib/occupancy.js';
import { mergeOccupancy } from '../src/renderer/occupancy-slice.js';

const occupancy = {
  systemTokens: 100,
  toolsTokens: 200,
  conversationTokens: 700,
  totalTokens: 1_000,
  capacityTokens: 8_000,
};

describe('occupancyFillRatio', () => {
  it('合计相对容量，超过窗口封顶为 1', () => {
    expect(occupancyFillRatio(occupancy)).toBe(0.125);
    expect(occupancyOverCapacity(occupancy)).toBe(false);
    expect(
      occupancyFillRatio({ ...occupancy, totalTokens: 12_000, capacityTokens: 8_000 }),
    ).toBe(1);
    expect(
      occupancyOverCapacity({ ...occupancy, totalTokens: 12_000, capacityTokens: 8_000 }),
    ).toBe(true);
  });
});

describe('formatTokenCount', () => {
  it('满千用 k，不满千用整数', () => {
    expect(formatTokenCount(12)).toBe('12');
    expect(formatTokenCount(1_200)).toBe('1.2k');
    expect(formatTokenCount(10_000)).toBe('10k');
  });
});

describe('mergeOccupancy', () => {
  it('没有新投影时保住上一份，切会话才清空', () => {
    expect(mergeOccupancy(occupancy, undefined)).toEqual(occupancy);
    expect(mergeOccupancy(occupancy, { ...occupancy, totalTokens: 2_000 })).toEqual({
      ...occupancy,
      totalTokens: 2_000,
    });
    expect(mergeOccupancy(undefined, undefined)).toBeUndefined();
  });
});
