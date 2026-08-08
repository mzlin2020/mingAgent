import { describe, expect, it } from 'vitest';
import { decodeImageAttachment } from '../src/main/multimodal-input.js';

/**
 * `decodeImageAttachment` 的纯函数单测。
 *
 * 拆出这个函数就是为了让它能脱离 `Services`/Electron 单独测——真正的强制校验
 * 在这里，`SendUserMessageRequest` 的 zod schema 只是粗筛（base64 字符数上限，
 * 膨胀系数不精确），精确的原始字节数校验只能在解码之后。
 */
describe('decodeImageAttachment', () => {
  it('正常解码：拿到字节、mime、name', () => {
    const data = Buffer.from('hello').toString('base64');
    const out = decodeImageAttachment({ data, mime: 'image/png', name: 'a.png' });
    expect(out.bytes.toString('utf8')).toBe('hello');
    expect(out.mime).toBe('image/png');
    expect(out.name).toBe('a.png');
  });

  it('name 缺省时输出里也不带这个字段', () => {
    const data = Buffer.from('hello').toString('base64');
    const out = decodeImageAttachment({ data, mime: 'image/png' });
    expect('name' in out).toBe(false);
  });

  it('🔴 超过 10MB 上限拒绝', () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const data = bytes.toString('base64');
    expect(() => decodeImageAttachment({ data, mime: 'image/png' })).toThrow(/10MB/);
  });

  it('🔴 非 image/* mime 拒绝 —— 渲染层不可信，不能只信它报的 Content-Type', () => {
    const data = Buffer.from('#!/bin/sh\n').toString('base64');
    expect(() => decodeImageAttachment({ data, mime: 'application/x-sh' })).toThrow(/image\/\*/);
  });
});
