import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../src/renderer/lib/relative-time.js';

/**
 * Home「最近会话」的相对时间（ADR-0037 补记）。
 *
 * `formatRelativeTime` 收 `now` 作参数正是为了这里：边界（59 秒 / 60 秒 / 跨午夜）
 * 全部用钉死的时间戳断言，不用假造计时器，也不会在 CI 的某个时区上莫名其妙地飘。
 */
const at = (s: string): number => new Date(s).getTime();

describe('formatRelativeTime', () => {
  it('一分钟内是"刚刚"，正好一分钟开始进分钟档', () => {
    const now = at('2026-08-10T12:00:00');
    expect(formatRelativeTime(now - 59_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 分钟前');
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('59 分钟前');
  });

  it('一小时到一天之间按小时说', () => {
    const now = at('2026-08-10T12:00:00');
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1 小时前');
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe('23 小时前');
  });

  it('跨了午夜但不足 24 小时，仍然说小时——凌晨看"昨天"会误以为很久以前', () => {
    const now = at('2026-08-10T00:30:00');
    expect(formatRelativeTime(at('2026-08-09T21:30:00'), now)).toBe('3 小时前');
  });

  it('超过 24 小时按自然日算，不是按 24 小时的整数倍', () => {
    const now = at('2026-08-10T12:00:00');
    expect(formatRelativeTime(at('2026-08-09T10:00:00'), now)).toBe('昨天');
    expect(formatRelativeTime(at('2026-08-08T23:59:00'), now)).toBe('2 天前');
    expect(formatRelativeTime(at('2026-08-05T12:00:00'), now)).toBe('5 天前');
  });

  it('满七天起写日期；跨年补上年份', () => {
    const now = at('2026-08-10T12:00:00');
    expect(formatRelativeTime(at('2026-08-03T12:00:00'), now)).toBe('8月3日');
    expect(formatRelativeTime(at('2026-01-09T12:00:00'), now)).toBe('1月9日');
    expect(formatRelativeTime(at('2025-12-31T12:00:00'), now)).toBe('2025年12月31日');
  });

  it('时钟回拨导致的未来时间戳归到"刚刚"，不显示"1 分钟后"', () => {
    const now = at('2026-08-10T12:00:00');
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe('刚刚');
  });
});
