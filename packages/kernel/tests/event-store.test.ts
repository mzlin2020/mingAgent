import { describe, expect, it } from 'vitest';
import { REDACTED, createEvent, newSessionId, newTurnId } from '@xm/contracts';
import { EVENT_STORE_CONTRACT, MemoryEventStore, sealEvent } from '@xm/kernel';

/**
 * 端口契约跑在参考实现上。
 *
 * `packages/storage` 的 SQLite 适配器落地时，这个文件只需换掉工厂函数——
 * 用例本身一条都不用改。那正是把契约从 ADR 里搬进代码的意义。
 */
describe('EventStore 端口契约 · MemoryEventStore', () => {
  for (const c of EVENT_STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(() => new MemoryEventStore());
    });
  }
});

describe('sealEvent：入库前的统一脱敏出口', () => {
  const S = newSessionId();

  it('🔴 密钥形态的字符串在落库前就被抹掉', () => {
    const e = sealEvent(
      createEvent({
        type: 'error.raised',
        sessionId: S,
        seq: 1,
        ts: 1,
        payload: {
          fatal: false,
          error: {
            code: 'provider_error',
            message: '认证失败',
            retryable: false,
            // 这是脱敏函数的样本，不是真钥匙；行尾标记让提交前扫描跳过（scripts/check-secrets.mjs）
            detail: { authorization: 'Bearer sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, // xm-secret-scan:allow
          },
        },
      }),
    );
    expect(JSON.stringify(e)).not.toContain('sk-ant-api03');
    expect(JSON.stringify(e)).toContain(REDACTED);
  });

  /**
   * 这条是 ADR-0013 期间实测抓到的：`SENSITIVE_KEY` 里的 `token` 不带边界，
   * 于是 `inputTokens` 命中键名匹配，整数被换成 `'***'`。
   * 若当时按"append 路径统一 redact"直接上线，成本核算会从第一天起就是错的，
   * 而且没有任何报错——`looseObject` 连类型都不会拦。
   */
  it('🔴 usage.recorded 的 token 计数不能被脱敏误伤', () => {
    const e = sealEvent(
      createEvent({
        type: 'usage.recorded',
        sessionId: S,
        seq: 1,
        ts: 1,
        turnId: newTurnId(),
        payload: {
          turnId: newTurnId(),
          provider: 'anthropic',
          model: 'claude-opus-5',
          usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7, cacheWriteTokens: 8 },
          costUsd: 0.012,
        },
      }),
    );
    expect(e.payload).toMatchObject({ usage: { inputTokens: 1234, outputTokens: 56 } });
  });

  it('封存是幂等的 —— 重复封存不改变内容', () => {
    const once = sealEvent(
      createEvent({
        type: 'notice.posted',
        sessionId: S,
        seq: 1,
        ts: 1,
        payload: { level: 'info', code: 'x', message: 'hi' },
      }),
    );
    expect(sealEvent(once)).toEqual(once);
  });
});
