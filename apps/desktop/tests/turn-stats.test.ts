import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDuration,
  formatStatsLine,
  sessionWallMs,
} from '../src/renderer/lib/turn-stats.js';

describe('formatDuration', () => {
  it('秒与分秒都用等宽数字能排开的形状', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(-1)).toBe('0s');
  });
});

describe('formatCost', () => {
  it('区分未知与 0：没价格是未知，计价后的 0 是 $0.00', () => {
    expect(formatCost(0, 1)).toBe('未知');
    expect(formatCost(0, 0)).toBe('$0.0000');
    expect(formatCost(0.042, 0)).toBe('$0.0420');
    expect(formatCost(0.42, 3)).toBe('$0.4200（3 次未计价）');
  });
});

describe('formatStatsLine', () => {
  it('tokens 输入/输出 · 用时 · 花费，缺一段就省略一段', () => {
    expect(
      formatStatsLine({
        inputTokens: 1234,
        outputTokens: 56,
        wallMs: 12_400,
        costUsd: 0.042,
        unpricedTurns: 0,
      }),
    ).toBe('1,234 / 56 · 12s · $0.0420');
  });

  it('没有任何用量、花费、用时就不渲染这一行', () => {
    expect(
      formatStatsLine({
        inputTokens: 0,
        outputTokens: 0,
        wallMs: undefined,
        costUsd: 0,
        unpricedTurns: 0,
      }),
    ).toBeUndefined();
  });

  it('花费未知时不写成 $0.00', () => {
    expect(
      formatStatsLine({
        inputTokens: 10,
        outputTokens: 2,
        wallMs: 1000,
        costUsd: 0,
        unpricedTurns: 1,
      }),
    ).toBe('10 / 2 · 1s · 未知');
  });
});

describe('sessionWallMs', () => {
  it('用首末消息时间戳，缺一边就没有用时', () => {
    expect(sessionWallMs(1000, 2500)).toBe(1500);
    expect(sessionWallMs(undefined, 2500)).toBeUndefined();
    expect(sessionWallMs(3000, 1000)).toBeUndefined();
  });
});
