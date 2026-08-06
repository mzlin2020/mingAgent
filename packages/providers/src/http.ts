import type { XmError } from '@xm/contracts';
import { redact, xmError } from '@xm/contracts';
import type { AbortLike } from '@xm/kernel';

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
}

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

  let attempt = 0;
  for (;;) {
    const bridge = bridgeAbort(options.signal);
    let response: Response;

    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify(options.body),
        signal: bridge.signal,
      });
    } catch (e) {
      bridge.dispose();
      if (options.signal.aborted) throw new ProviderHttpError(ABORTED);
      // 网络层失败（DNS、连接重置）：与 5xx 同类，可重试
      const err = new ProviderHttpError(
        xmError('provider_error', `连接 ${options.providerId} 失败：${describe(e)}`, {
          retryable: true,
        }),
      );
      if (attempt >= maxRetries) throw err;
      attempt += 1;
      await sleep(backoffMs(retryBase, attempt), options.signal);
      continue;
    }

    if (response.ok) {
      if (response.body === null) {
        bridge.dispose();
        throw new ProviderHttpError(
          xmError('provider_error', `${options.providerId} 返回了 200 但没有响应体。`),
        );
      }
      /*
       * **刻意不 dispose。** 监听器要一直活到流被读完为止——
       * 请求已经返回，但正文才刚开始流式吐出，取消在这一段才最常发生。
       * 监听器随 bridge.signal 一起被 GC，不会泄漏。
       */
      return response.body;
    }

    const detail = await readErrorBody(response);
    bridge.dispose();
    const xm = classify(response.status, detail, options.providerId);

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      throw new ProviderHttpError(xm);
    }

    attempt += 1;
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    await sleep(Math.max(retryAfter ?? 0, backoffMs(retryBase, attempt)), options.signal);
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
function bridgeAbort(signal: AbortLike): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
    },
  };
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

// ── 错误归类 ────────────────────────────────────────────────────

const ABORTED = xmError('aborted', '已停止。', { retryable: false });

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * HTTP 状态码 → `ErrorCode`。
 *
 * 分得细是有用的：`ErrorCode` 那份闭集的注释写着「三者的用户处置完全不同」，
 * 这里同理——401 要用户去换 key，429 要等，413/context_overflow 要压缩上下文，
 * 500 只需要重试。全归成 `provider_error` 的话，UI 只能显示"失败了"。
 */
function classify(status: number, body: string, providerId: string): XmError {
  const brief = body === '' ? '' : `：${body.slice(0, 500)}`;

  if (status === 401 || status === 403) {
    return xmError('provider_error', `${providerId} 拒绝了这个 API key（HTTP ${String(status)}）${brief}`, {
      retryable: false,
      detail: { status },
    });
  }
  if (status === 429) {
    return xmError('rate_limited', `${providerId} 限流（HTTP 429）${brief}`, { detail: { status } });
  }
  if (status === 413 || looksLikeContextOverflow(body)) {
    return xmError('context_overflow', `上下文超出模型上限${brief}`, {
      retryable: false,
      detail: { status },
    });
  }
  if (status >= 500) {
    return xmError('provider_error', `${providerId} 服务端错误（HTTP ${String(status)}）${brief}`, {
      detail: { status },
    });
  }
  return xmError('provider_error', `${providerId} 拒绝了请求（HTTP ${String(status)}）${brief}`, {
    retryable: false,
    detail: { status },
  });
}

const looksLikeContextOverflow = (body: string): boolean =>
  /context[_ ]length|too many tokens|maximum context|prompt is too long/i.test(body);

/**
 * 错误正文**必须过 redact**。
 *
 * 看起来多此一举——key 在请求头里，不会出现在响应里。但错误正文经常把请求原样回显，
 * 而我们送出去的 body 里有工具入参、文件路径、有时是模型刚从环境里读到的东西。
 * 这一串会进 `XmError.message`，而 `XmError` 会进事件流、进审计、进 UI。
 * `redact` 的定位是"尽力而为的统一出口"，这里正是它该在的地方之一。
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return typeof redact(text) === 'string' ? (redact(text) as string) : '';
  } catch {
    return '';
  }
}

/** `Retry-After` 可以是秒数，也可以是 HTTP 日期 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** 指数退避 + 抖动。抖动是为了避免多个会话在同一毫秒一起重试 */
const backoffMs = (base: number, attempt: number): number =>
  Math.round(base * 2 ** (attempt - 1) * (0.5 + Math.random()));

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
