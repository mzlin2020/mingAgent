import { describe, expect, it } from 'vitest';
import {
  ALL_EVENT_TYPES,
  EVENT_SPECS,
  PERSISTED_EVENT_TYPES,
  TRANSIENT_EVENT_TYPES,
  isExtEventType,
  isKnownEventType,
} from '@xm/contracts';

describe('事件注册表', () => {
  it('每个事件类型都有 schema、durability、version', () => {
    for (const type of ALL_EVENT_TYPES) {
      const spec = EVENT_SPECS[type];
      expect(spec.schema, type).toBeDefined();
      expect(['persisted', 'transient'], type).toContain(spec.durability);
      expect(spec.version, type).toBeGreaterThanOrEqual(1);
    }
  });

  it('持久化与瞬态两层不重不漏', () => {
    expect([...PERSISTED_EVENT_TYPES, ...TRANSIENT_EVENT_TYPES].sort()).toEqual(
      [...ALL_EVENT_TYPES].sort(),
    );
  });

  /**
   * 瞬态清单是刻意收紧的：只有 token 级增量与工具进度可以是瞬态。
   * 新增瞬态事件必须显式改这个断言 —— 因为每加一个瞬态事件，
   * "状态完全由持久化流决定"这条不变量的检验面就大一分（ADR-0008）。
   */
  it('瞬态事件只有 message.delta 与 tool.progress', () => {
    expect([...TRANSIENT_EVENT_TYPES].sort()).toEqual(['message.delta', 'tool.progress']);
  });

  it('事件名一律小写点分', () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(type, type).toMatch(/^[a-z]+(\.[a-z]+)*$/);
    }
  });

  it('版本号大于 1 的事件必须提供 upcaster（ADR-0008）', () => {
    for (const type of ALL_EVENT_TYPES) {
      const spec: { version: number; upcasters?: Record<number, unknown> } = EVENT_SPECS[type];
      if (spec.version === 1) continue;
      for (let v = 1; v < spec.version; v++) {
        expect(spec.upcasters?.[v], `${type} 缺少 v${String(v)} → v${String(v + 1)} 的 upcaster`).toBeTypeOf(
          'function',
        );
      }
    }
  });

  it('ext.* 不属于核心事件类型', () => {
    expect(isKnownEventType('ext.foo.bar')).toBe(false);
    expect(isExtEventType('ext.foo.bar')).toBe(true);
    expect(isExtEventType('notice.posted')).toBe(false);
  });
});

/**
 * 事件命名的护栏。
 *
 * 三个裸名（`usage` / `notice` / `error`）在落库前改成了 `usage.recorded` 等
 * （ADR-0012 ⑪）。但"以后别再写裸名"如果只写在文档里，下一个加事件的人不会看到——
 * 而这次能纯文本替换，是因为还没有数据落库；下次就要写迁移了。
 *
 * 所以把它变成注册表自身的断言：**新增事件类型时，这个测试是唯一会拦住你的东西。**
 */
describe('事件命名约定', () => {
  const NAMING = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

  it('🔴 一律 <实体>.<动作>，不允许裸名', () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(type, `事件名 "${type}" 缺少前缀`).toMatch(NAMING);
    }
  });

  it('前缀分组可用 —— UI 订阅与策略匹配都靠它', () => {
    const groups = new Set(ALL_EVENT_TYPES.map((t) => t.split('.')[0]));
    expect(groups).toContain('usage');
    expect(groups).toContain('notice');
    expect(groups).toContain('error');
    // 裸名会让分组退化成事件名本身，这里顺带证明分组数严格小于事件数
    expect(groups.size).toBeLessThan(ALL_EVENT_TYPES.length);
  });
});
