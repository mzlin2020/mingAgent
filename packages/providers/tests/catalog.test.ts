import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../src/catalog.js';

describe('模型能力表', () => {
  it('DeepSeek 主模型不再沿用未知模型的 4096 输出兜底', () => {
    expect(capabilitiesFor('deepseek-v4-flash').maxOutput).toBe(16_384);
  });

  it('未知模型仍保持保守输出上限', () => {
    expect(capabilitiesFor('unknown-model').maxOutput).toBe(4_096);
  });
});
