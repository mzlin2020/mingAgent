import { describe, expect, it } from 'vitest';
import { normalizeHostTarget, pinnedHostKey, splitNormalizedHostPort } from '@xm/kernel';

/**
 * `pinnedHosts` 的键（地基复审四 B2）。
 *
 * 这张表是"判定用的 IP = 实际建连的 IP"这条 SSRF 防线的**唯一**传递通道：
 * 网关按主机名写进去，工具按主机名查出来。两边算键的方式差一点，查表就落空，
 * 而落空的表现是工具抛一句"内部错误"——看起来像 bug，实际上是防线的接缝错位。
 *
 * 所以这里钉的不是"这个函数返回什么"，而是**两侧算出来的是同一个键**。
 * 结构性的保证在代码里（两边调的是这一个函数），这里补的是它的行为契约。
 */

describe('🔴 pinnedHostKey 与 normalizeHostTarget 同源', () => {
  it.each([
    ['普通域名', 'http://example.com/', 'example.com'],
    ['带非默认端口', 'http://example.com:8080/x', 'example.com'],
    ['默认端口写出来也一样', 'https://example.com:443/', 'example.com'],
    ['大小写', 'http://EXAMPLE.CoM/', 'example.com'],
    // ↓ 这两条正是 B2 里"从来没成功过一次"的两类
    ['FQDN 尾点', 'http://example.com./', 'example.com'],
    ['IPv6 字面量', 'http://[::1]:8080/', '[::1]'],
    ['IPv6 非规范写法', 'http://[0:0:0:0:0:0:0:1]/', '[::1]'],
    ['IPv6 内嵌 v4', 'http://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]'],
    ['userinfo 骗人', 'http://good.com@evil.com/', 'evil.com'],
  ])('%s → %s', (_label, url, expected) => {
    expect(pinnedHostKey(url)).toBe(expected);
  });

  it('归一都过不了的 URL 没有键——那时轮不到查表，判定更早就失败关闭了', () => {
    expect(pinnedHostKey('file:///etc/passwd')).toBeUndefined();
    expect(pinnedHostKey('example.com:8080')).toBeUndefined();
    expect(pinnedHostKey('')).toBeUndefined();
  });

  /*
   * 键必须**恒等于** `normalizeHostTarget` 归一后去掉端口的那一段——
   * 网关是在归一之后的串上工作的，工具是在原始 URL 上工作的，
   * 这条断言就是"两条路通向同一个字符串"本身。
   */
  it.each([
    'http://example.com/',
    'http://example.com:8080/a/b?c=d',
    'https://example.com./',
    'http://[::1]/',
    'http://[0:0:0:0:0:0:0:1]:9/',
  ])('%s：原始 URL 与归一串两条路算出同一个键', (url) => {
    const normalized = normalizeHostTarget(url);
    if (!normalized.ok) throw new Error('这些都应当能过归一');
    expect(pinnedHostKey(url)).toBe(splitNormalizedHostPort(normalized.value).host);
  });
});

describe('splitNormalizedHostPort', () => {
  it.each([
    ['example.com', 'example.com', undefined],
    ['example.com:8080', 'example.com', '8080'],
    ['[::1]', '[::1]', undefined],
    ['[::1]:8080', '[::1]', '8080'],
  ])('%s → host=%s port=%s', (value, host, port) => {
    expect(splitNormalizedHostPort(value)).toEqual({ host, port });
  });
});
