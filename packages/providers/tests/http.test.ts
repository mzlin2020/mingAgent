import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, postSse, readSseFrames } from '@xm/providers';
import { abortLike, abortableStream, streamOf } from './helpers/stream.js';

/**
 * HTTP 层：取消桥接、退避、错误归类、脱敏。
 *
 * 其中**取消**那一组是「停止按钮 200ms 内真停」这条 DoD 的单元级证据。
 * 端到端的证据在 `packages/runtime/tests/interrupt.test.ts`。
 */

const sse = (body: string): Response =>
  new Response(streamOf(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const OPTS = { url: 'https://example.test/v1/x', headers: {}, body: {}, providerId: 'test' };

describe('取消桥接', () => {
  it('🔴 abort 之后 fetch 收到的 signal 当场为 aborted —— 不是等下一个 chunk 才发现', async () => {
    const ab = abortLike();
    let seen: AbortSignal | undefined;

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(sse('data: x\n\n'));
    }) as unknown as typeof fetch;

    await postSse({ ...OPTS, signal: ab.signal, fetchImpl });
    expect(seen?.aborted).toBe(false);

    ab.abort();

    /*
     * 这一条才是要害。模型可能正卡在一段长思考里，下一个 chunk 是三十秒之后——
     * 靠"循环里检查 aborted"的实现，此刻 signal 仍然是 false，
     * 用户点了停止而光标继续闪三十秒。
     */
    expect(seen?.aborted).toBe(true);
  });

  it('调用前就已经 abort 的话，fetch 拿到的 signal 一开始就是 aborted', async () => {
    const ab = abortLike();
    ab.abort();
    let seen: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(sse(''));
    }) as unknown as typeof fetch;

    await postSse({ ...OPTS, signal: ab.signal, fetchImpl });
    expect(seen?.aborted).toBe(true);
  });

  it('🔴 取消会让正在读的 SSE 循环立刻退出 —— 哪怕上游一个字节都不再来', async () => {
    const ab = abortLike();

    const fetchImpl = ((_url: string, init?: RequestInit) => {
      // 真 fetch/undici 的行为：signal 一 abort，正文读取当场抛
      const signal = init?.signal;
      const bridged = {
        addEventListener: (_t: 'abort', l: () => void) => signal?.addEventListener('abort', l),
        removeEventListener: (_t: 'abort', l: () => void) => signal?.removeEventListener('abort', l),
        aborted: signal?.aborted ?? false,
      };
      return Promise.resolve(new Response(abortableStream(bridged, 'data: one\n\n'), { status: 200 }));
    }) as unknown as typeof fetch;

    const body = await postSse({ ...OPTS, signal: ab.signal, fetchImpl });

    const seen: string[] = [];
    const started = Date.now();
    const loop = (async () => {
      try {
        for await (const f of readSseFrames(body)) seen.push(f.data);
      } catch {
        // 取消表现为读取抛错，这正是 Turn 循环那一侧要接住的形状
      }
    })();

    // 上游此刻什么都不会再发。靠"下一个 chunk 到达时检查 aborted"的实现，这里会永远挂住
    ab.abort();
    await loop;

    expect(seen).toEqual(['one']);
    // 200ms 是 DoD 里的数字。挂住的话差的是数量级，不是几十毫秒
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('退避睡眠期间被取消，不会睡满', async () => {
    const ab = abortLike();
    const fetchImpl = (() => Promise.resolve(new Response('busy', { status: 429 }))) as unknown as typeof fetch;

    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      ab.abort();
      return Promise.resolve();
    };

    await expect(
      postSse({ ...OPTS, signal: ab.signal, fetchImpl, sleep, maxRetries: 3, retryBaseMs: 10_000 }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    // 真睡下去的话这条用例会超时，而不是失败——所以 sleep 是注入的
    expect(slept.length).toBeGreaterThan(0);
  });
});

describe('退避与重试', () => {
  it('🔴 429 会退避重试，且读 Retry-After', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(
        calls < 3
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
          : sse('data: ok\n\n'),
      );
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    await postSse({
      ...OPTS,
      signal: abortLike().signal,
      fetchImpl,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      retryBaseMs: 10,
    });

    expect(calls).toBe(3);
    // Retry-After=2s 压过指数退避的基数，取两者中的大者
    expect(slept.every((ms) => ms >= 2000)).toBe(true);
  });

  it('🔴 4xx 不重试 —— 重发只是把同一个错误再送一遍', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response('bad key', { status: 401 }));
    }) as unknown as typeof fetch;

    await expect(
      postSse({ ...OPTS, signal: abortLike().signal, fetchImpl, sleep: () => Promise.resolve() }),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('5xx 重试到上限后仍然抛结构化错误', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('boom', { status: 503 }))) as unknown as typeof fetch;
    await expect(
      postSse({
        ...OPTS,
        signal: abortLike().signal,
        fetchImpl,
        sleep: () => Promise.resolve(),
        maxRetries: 2,
      }),
    ).rejects.toMatchObject({ xm: { code: 'provider_error', retryable: true } });
  });
});

describe('错误归类', () => {
  const cases: readonly [number, string, string][] = [
    [401, '', 'provider_error'],
    [429, '', 'rate_limited'],
    [413, '', 'context_overflow'],
    [400, 'prompt is too long', 'context_overflow'],
    [400, '', 'provider_error'],
  ];

  for (const [status, body, code] of cases) {
    it(`HTTP ${String(status)}${body === '' ? '' : `（${body}）`} → ${code}`, async () => {
      const fetchImpl = (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;
      await expect(
        postSse({
          ...OPTS,
          signal: abortLike().signal,
          fetchImpl,
          sleep: () => Promise.resolve(),
          maxRetries: 0,
        }),
      ).rejects.toMatchObject({ xm: { code } });
    });
  }

  it('🔴 错误正文过 redact —— 它会一路进事件流、审计与 UI', async () => {
    // 服务端把请求原样回显是常见行为，而我们送出去的 body 里可能带着刚读到的东西
    // 逐行豁免必须写在同一行上（scripts/check-secrets.mjs 是按行匹配的）
    const leak = 'echo of your request: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // xm-secret-scan:allow 脱敏用例必须的密钥形态样本
    const fetchImpl = (() => Promise.resolve(new Response(leak, { status: 400 }))) as unknown as typeof fetch;

    await expect(
      postSse({ ...OPTS, signal: abortLike().signal, fetchImpl, maxRetries: 0 }),
    ).rejects.toSatisfy((e: unknown) => {
      const message = (e as Error).message;
      return !message.includes('sk-ant-api03') && message.includes('***');
    });
  });

  it('200 但没有响应体 → 明确报错，而不是解出一个空回复', async () => {
    const fetchImpl = (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    await expect(postSse({ ...OPTS, signal: abortLike().signal, fetchImpl })).rejects.toThrow(/没有响应体/);
  });
});
