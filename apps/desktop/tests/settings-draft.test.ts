import { describe, expect, it } from 'vitest';
import {
  isImplementedProviderKind,
  parsePriceField,
  providerKindOptions,
  uniqueDenyRuleId,
  uniqueRecordKey,
} from '../src/renderer/lib/settings-draft.js';

describe('uniqueRecordKey', () => {
  it('已占用则追加 -2、-3', () => {
    expect(uniqueRecordKey(['openai'], 'openai')).toBe('openai-2');
    expect(uniqueRecordKey(['openai', 'openai-2'], 'openai')).toBe('openai-3');
    expect(uniqueRecordKey([], 'openai')).toBe('openai');
  });
});

describe('uniqueDenyRuleId', () => {
  it('先为后缀留位置再截到 80，长 glob 不会撞上同一个 id', () => {
    const target = `~/${'a'.repeat(120)}/**`;
    const first = uniqueDenyRuleId('fs.write', target, new Set());
    expect(first).toHaveLength(80);
    const second = uniqueDenyRuleId('fs.write', target, new Set([first]));
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(80);
    expect(second.endsWith('-2')).toBe(true);
  });

  it('base 恰好 80 且已占用时，后缀仍能让新 id 不同于原 id', () => {
    const target = 'x'.repeat(200);
    const first = uniqueDenyRuleId('fs.write', target, new Set());
    expect(first).toHaveLength(80);
    const second = uniqueDenyRuleId('fs.write', target, new Set([first]));
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(80);
  });
});

describe('parsePriceField', () => {
  it('未写完的小数点不回写成数字', () => {
    expect(parsePriceField('3.')).toBeUndefined();
    expect(parsePriceField('0.')).toBeUndefined();
    expect(parsePriceField('.')).toBeUndefined();
  });

  it('合法小数与空串', () => {
    expect(parsePriceField('0.15')).toBe(0.15);
    expect(parsePriceField('.5')).toBe(0.5);
    expect(parsePriceField('')).toBe(0);
    expect(parsePriceField('3')).toBe(3);
  });

  it('拒绝负数和非法字符', () => {
    expect(parsePriceField('-1')).toBeUndefined();
    expect(parsePriceField('1e2')).toBeUndefined();
    expect(parsePriceField('1.2.3')).toBeUndefined();
  });
});

describe('providerKindOptions', () => {
  it('只列出当前能打开的类型；已有未接入类型仍保留在选项里', () => {
    expect(providerKindOptions('openai')).toEqual(['anthropic', 'openai', 'openai-compatible']);
    expect(providerKindOptions('ollama')).toEqual(['anthropic', 'openai', 'openai-compatible', 'ollama']);
    expect(isImplementedProviderKind('google')).toBe(false);
    expect(isImplementedProviderKind('anthropic')).toBe(true);
  });
});
