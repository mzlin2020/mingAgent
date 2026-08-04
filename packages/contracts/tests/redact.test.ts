import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '@xm/contracts';

describe('redact：日志与审计的统一出口过滤', () => {
  it('按键名脱敏', () => {
    expect(redact({ apiKey: 'anything-at-all', api_key: 'x', normal: 'keep' })).toEqual({
      apiKey: REDACTED,
      api_key: REDACTED,
      normal: 'keep',
    });
  });

  // 下面几处是刻意构造的**假**密钥样本，用来验证脱敏本身。
  // 行尾的 xm-secret-scan:allow 让提交前扫描跳过这一行（见 scripts/check-secrets.mjs）。
  it('按值的形态脱敏——即使键名无辜（如 argv 数组里的裸 key）', () => {
    const argv = ['curl', '-H', 'Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA']; // xm-secret-scan:allow
    const out = redact({ argv }) as { argv: string[] };
    expect(out.argv[2]).not.toContain('sk-ant-api03-');
    expect(out.argv[2]).toContain(REDACTED);
  });

  it('识别常见凭据形态', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE', // xm-secret-scan:allow
      'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // xm-secret-scan:allow
      `AIza${'A'.repeat(35)}`,
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', // xm-secret-scan:allow
    ];
    for (const s of samples) {
      expect(redact(s), s.slice(0, 12)).toContain(REDACTED);
    }
  });

  it('递归进数组与嵌套对象', () => {
    expect(redact({ list: [{ token: 'abc' }, { safe: 1 }] })).toEqual({
      list: [{ token: REDACTED }, { safe: 1 }],
    });
  });

  it('循环引用不会死循环——审计对象可能来自任意工具输出', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it('保持非字符串标量不变', () => {
    expect(redact({ n: 1, b: true, nil: null })).toEqual({ n: 1, b: true, nil: null });
  });
});
