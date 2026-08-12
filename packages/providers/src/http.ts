import type { XmError } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type { AbortLike } from '@xm/kernel';
import { classifyHttpError, isRetryableStatus, parseRetryAfter, readErrorBody } from './http-errors.js';

/**
 * Provider 的 HTTP 层：取消桥接、退避重试、错误归类。
 *
 * 这个文件里最要紧的是**取消桥接**——「点停止后 200ms 内真停」这条 DoD
 * 唯一的落点就在这里的十几行。见 `bridgeAbort` 的注释。
 */

/** 带结构化 XmError 的错误。适配器捕获后原样转成事件，不再二次翻译 */
export class ProviderHttpError extends Error {
  readonly xm: XmError;
  constructor(xm: XmError) {
    super(xm.message);
    this.name = 'ProviderHttpError';
    this.xm = xm;
  }
}

export interface HttpDeps {
  /** 测试注入。生产用全局 fetch */
  readonly fetchImpl?: typeof fetch;
  /** 测试注入，免得退避用例真的睡 8 秒 */
  readonly sleep?: (ms: number, signal: AbortLike) => Promise<void>;
  readonly maxRetries?: number;
  /** 退避基数（ms）。真实退避是 base * 2^attempt，再加抖动 */
  readonly retryBaseMs?: number;
  /** 从发起请求到收到首个响应字节的上限。 */
  readonly firstByteTimeoutMs?: number;
  /** 首字节之后，相邻响应字节块之间允许的最大空闲时间。 */
  readonly streamIdleTimeoutMs?: number;
  /** 瞬态连接状态；用于 UI，不应写入模型回复。 */
  readonly onStatus?: (status: ProviderStreamStatus) => void | Promise<void>;
}

export type ProviderStreamStatus =
  | {
      readonly phase: 'retrying';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: string;
    }
  | { readonly phase: 'connected' };

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 90_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

type ByteReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value: Uint8Array | undefined };

export interface PostSseOptions extends HttpDeps {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortLike;
  /** 出现在错误消息里的家名，如 "anthropic" */
  readonly providerId: string;
}

/**
 * POST 一个 JSON 请求，拿回 SSE 字节流。
 *
 * 只有 429 / 5xx 才重试，且**重试次数用尽后抛的仍然是同一个结构化错误**——
 * 调用方不需要区分"第一次就失败"和"重试完还是失败"。
 * 4xx 一律不重试：请求本身有问题，重发只是把同一个错误再送一遍。
 */
export async function postSse(options: PostSseOptions): Promise<ReadableStream<Uint8Array>> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 3;
  const retryBase = options.retryBaseMs ?? 500;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    const bridge = bridgeAbort(options.signal);
    let response: Response;
    const firstByteDeadline = Date.now() + firstByteTimeoutMs;

    try {
      response = await withTimeout(
        doFetch(options.url, {
          method: 'POST',
          headers: { ...options.headers, 'content-type': 'application/json' },
          body: JSON.stringify(options.body),
          signal: bridge.signal,
        }),
        firstByteTimeoutMs,
        () => {
          bridge.abort();
        },
      );
    } catch (e) {
      bridge.dispose();
      throwIfAborted(options.signal);
      // 网络层失败（DNS、连接重置）：与 5xx 同类，可重试
      const err = new ProviderHttpError(
        e instanceof TimeoutMarker
          ? firstByteTimeoutError(options.providerId, firstByteTimeoutMs)
          : xmError('provider_error', `连接 ${options.providerId} 失败：${describe(e)}`, {
              retryable: true,
            }),
      );
      if (attempt >= maxRetries) throw err;
      attempt += 1;
      const delayMs = backoffMs(retryBase, attempt);
      await notifyRetry(options, attempt, maxRetries, delayMs, err.message);
      await sleep(delayMs, options.signal);
      throwIfAborted(options.signal);
      continue;
    }

    if (response.ok) {
      if (response.body === null) {
        bridge.dispose();
        throw new ProviderHttpError(
          xmError('provider_error', `${options.providerId} 返回了 200 但没有响应体。`),
        );
      }
      const reader = response.body.getReader();
      let first: ByteReadResult;
      try {
        first = await withTimeout(
          reader.read(),
          Math.max(1, firstByteDeadline - Date.now()),
          () => {
            bridge.abort();
          },
        );
      } catch (e) {
        void reader.cancel().catch(() => {
          return undefined;
        });
        bridge.dispose();
        throwIfAborted(options.signal);
        const err = new ProviderHttpError(
          e instanceof TimeoutMarker
            ? firstByteTimeoutError(options.providerId, firstByteTimeoutMs)
            : xmError('provider_error', `读取 ${options.providerId} 响应失败：${describe(e)}`, {
                retryable: true,
              }),
        );
        if (attempt >= maxRetries) throw err;
        attempt += 1;
        const delayMs = backoffMs(retryBase, attempt);
        await notifyRetry(options, attempt, maxRetries, delayMs, err.message);
        await sleep(delayMs, options.signal);
        throwIfAborted(options.signal);
        continue;
      }

      await options.onStatus?.({ phase: 'connected' });
      return monitoredBody({
        reader,
        first,
        idleTimeoutMs: streamIdleTimeoutMs,
        providerId: options.providerId,
        sourceSignal: options.signal,
        bridge,
      });
    }

    const detail = await readErrorBody(response);
    bridge.dispose();
    const xm = classifyHttpError(response.status, detail, options.providerId);

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      throw new ProviderHttpError(xm);
    }

    attempt += 1;
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const delayMs = Math.max(retryAfter ?? 0, backoffMs(retryBase, attempt));
    await notifyRetry(options, attempt, maxRetries, delayMs, xm.message);
    await sleep(delayMs, options.signal);
    throwIfAborted(options.signal);
  }
}

/**
 * 这个异常是不是"用户点了停止"造成的。
 *
 * 判据只看 `signal.aborted`，**不看异常的 name 或 message**：`AbortError` 是
 * undici 的形状，别的 fetch 实现（浏览器、Deno、测试替身）未必一样，而
 * "我们自己请求过取消"这个事实在任何实现下都成立。按异常形状判等于把
 * 一条端口级约定绑死在某个运行时的实现细节上。
 */
export const abortedBy = (signal: AbortLike): boolean => signal.aborted;

function throwIfAborted(signal: AbortLike): void {
  if (signal.aborted) throw new ProviderHttpError(ABORTED);
}

// ── 取消桥接 ────────────────────────────────────────────────────

/**
 * `AbortLike` → 真 `AbortSignal`。
 *
 * 端口刻意用 `AbortLike` 而不是 `AbortSignal`（内核不许引 DOM/@types/node），
 * 而 `fetch` 只认真货。这十几行就是两者之间的全部距离。
 *
 * **为什么必须是"事件转发"而不是"循环里检查 aborted"**：后者的语义是
 * "等下一个 chunk 到达时才发现该停了"。模型可能正卡在一段长思考里，
 * 那时下一个 chunk 是三十秒之后——用户点了停止，屏幕上的光标继续闪三十秒。
 * 转发给真 signal 之后，取消会让 fetch 的正文读取当场抛错，SSE 循环立刻退出。
 */
function bridgeAbort(signal: AbortLike): { signal: AbortSignal; abort: () => void; dispose: () => void } {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return {
      signal: controller.signal,
      abort: () => {
        controller.abort();
      },
      dispose: () => undefined,
    };
  }
  const onAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    abort: () => {
      controller.abort();
    },
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
    },
  };
}

class TimeoutMarker extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutMarker());
          onTimeout();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function monitoredBody(input: {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly first: ByteReadResult;
  readonly idleTimeoutMs: number;
  readonly providerId: string;
  readonly sourceSignal: AbortLike;
  readonly bridge: { readonly abort: () => void; readonly dispose: () => void };
}): ReadableStream<Uint8Array> {
  const first = input.first;
  let hasFirst = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = hasFirst
          ? first
          : await withTimeout(input.reader.read(), input.idleTimeoutMs, () => {
              input.bridge.abort();
            });
        hasFirst = false;
        if (next.done) {
          input.bridge.dispose();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (e) {
        input.bridge.dispose();
        if (input.sourceSignal.aborted) throw new ProviderHttpError(ABORTED);
        if (e instanceof TimeoutMarker) {
          throw new ProviderHttpError(
            xmError(
              'timeout',
              `${input.providerId} 的响应流已连续 ${String(Math.ceil(input.idleTimeoutMs / 1000))} 秒没有数据，已停止本次请求。`,
              { retryable: true },
            ),
          );
        }
        throw e;
      }
    },
    async cancel(reason) {
      input.bridge.abort();
      input.bridge.dispose();
      await input.reader.cancel(reason);
    },
  });
}

const firstByteTimeoutError = (providerId: string, timeoutMs: number): XmError =>
  xmError(
    'timeout',
    `等待 ${providerId} 首个响应数据超过 ${String(Math.ceil(timeoutMs / 1000))} 秒。`,
    { retryable: true },
  );

async function notifyRetry(
  options: PostSseOptions,
  retryNumber: number,
  maxRetries: number,
  delayMs: number,
  reason: string,
): Promise<void> {
  await options.onStatus?.({
    phase: 'retrying',
    attempt: retryNumber + 1,
    maxAttempts: maxRetries + 1,
    delayMs,
    reason,
  });
}

/** 退避期间也要能被取消——否则"停止"要等一次退避睡醒 */
const defaultSleep = (ms: number, signal: AbortLike): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });

const ABORTED = xmError('aborted', '已停止。', { retryable: false });

/** 指数退避 + 抖动。抖动是为了避免多个会话在同一毫秒一起重试 */
const backoffMs = (base: number, attempt: number): number =>
  Math.round(base * 2 ** (attempt - 1) * (0.5 + Math.random()));

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
