import { describe, expect, it } from 'vitest';
import type { BlobRef, ResultBlock, ResultLimits } from '@xm/contracts';
import { DEFAULT_RESULT_LIMITS } from '@xm/contracts';
import { truncateResult } from '@xm/kernel';

const limits = (over: Partial<ResultLimits> = {}): ResultLimits => ({
  ...DEFAULT_RESULT_LIMITS,
  ...over,
});

const text = (t: string): ResultBlock[] => [{ type: 'text', text: t }];

const blob: BlobRef = { hash: 'ab3f'.repeat(16), mime: 'text/plain', size: 999_999 };

describe('truncateResult', () => {
  it('未超限时原样返回', () => {
    const blocks = text('短输出');
    const out = truncateResult(blocks, limits());
    expect(out.truncated).toBe(false);
    expect(out.blocks).toEqual(blocks);
  });

  it('strategy=none 时永不截断', () => {
    const out = truncateResult(text('x'.repeat(1000)), limits({ maxBytes: 10, strategy: 'none' }));
    expect(out.truncated).toBe(false);
  });

  it('🔴 截断标记对模型可见 —— 悄悄截断会让模型基于残缺内容自信下结论', () => {
    const out = truncateResult(text('x'.repeat(5000)), limits({ maxBytes: 200 }));
    expect(out.truncated).toBe(true);
    const result = out.blocks[0]!;
    expect(result.type).toBe('text');
    expect(result.type === 'text' && result.text).toContain('已省略');
    expect(result.type === 'text' && result.text).toContain('result.expand');
  });

  it('有 blob 引用时标记里带出完整内容的地址', () => {
    const out = truncateResult(text('x'.repeat(5000)), limits({ maxBytes: 200 }), blob);
    const result = out.blocks[0]!;
    expect(result.type === 'text' && result.text).toContain('blob:sha256:');
  });

  it('head 策略保留开头', () => {
    const out = truncateResult(text('START' + 'x'.repeat(5000) + 'END'), limits({ maxBytes: 200, strategy: 'head' }));
    const t = out.blocks[0]!;
    expect(t.type === 'text' && t.text.startsWith('START')).toBe(true);
    expect(t.type === 'text' && t.text.includes('END')).toBe(false);
  });

  it('tail 策略保留结尾', () => {
    const out = truncateResult(text('START' + 'x'.repeat(5000) + 'END'), limits({ maxBytes: 200, strategy: 'tail' }));
    const t = out.blocks[0]!;
    expect(t.type === 'text' && t.text.endsWith('END')).toBe(true);
  });

  it('middle 策略头尾都保留 —— 命令输出的上下文在头、错误在尾', () => {
    const out = truncateResult(text('START\n' + 'x\n'.repeat(5000) + 'END'), limits({ maxBytes: 400 }));
    const t = out.blocks[0]!;
    expect(t.type === 'text' && t.text.startsWith('START')).toBe(true);
    expect(t.type === 'text' && t.text.endsWith('END')).toBe(true);
  });

  it('maxLines 独立生效', () => {
    const out = truncateResult(
      text(Array.from({ length: 500 }, (_, i) => `行 ${String(i)}`).join('\n')),
      limits({ maxLines: 20 }),
    );
    expect(out.truncated).toBe(true);
    expect(out.originalLines).toBe(500);
  });

  it('中文按字节计量，且不会把字符切碎', () => {
    const out = truncateResult(text('中'.repeat(1000)), limits({ maxBytes: 300 }));
    const t = out.blocks[0]!;
    expect(t.type).toBe('text');
    // 出现替换字符就说明切在了多字节序列中间
    expect(t.type === 'text' && t.text.includes('�')).toBe(false);
    expect(out.keptBytes).toBeLessThanOrEqual(300);
  });

  it('emoji（代理对）不会被切成半个', () => {
    const out = truncateResult(text('😀'.repeat(500)), limits({ maxBytes: 200 }));
    const t = out.blocks[0]!;
    expect(t.type === 'text' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t.text)).toBe(false);
    expect(t.type === 'text' && /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t.text)).toBe(false);
  });

  it('非文本块（图片/文档）原样保留 —— 它们本来就是 BlobRef', () => {
    const blocks: ResultBlock[] = [
      { type: 'text', text: 'x'.repeat(5000) },
      { type: 'image', source: blob },
    ];
    const out = truncateResult(blocks, limits({ maxBytes: 200 }));
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[1]).toEqual({ type: 'image', source: blob });
  });

  it('报告原始体积，供 UI 与审计使用', () => {
    const out = truncateResult(text('x'.repeat(5000)), limits({ maxBytes: 200 }));
    expect(out.originalBytes).toBe(5000);
    expect(out.keptBytes).toBeLessThanOrEqual(200);
  });
});
