import type { XmError } from '@xm/contracts';
import { redact, xmError } from '@xm/contracts';

export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** HTTP 状态码 → 面向用户的结构化错误。 */
export function classifyHttpError(status: number, body: string, providerId: string): XmError {
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
  if (status === 413 || /context[_ ]length|too many tokens|maximum context|prompt is too long/i.test(body)) {
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

/** 错误正文会进入事件、审计与 UI，因此必须先脱敏。 */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const safe = redact(text);
    return typeof safe === 'string' ? safe : '';
  } catch {
    return '';
  }
}

/** `Retry-After` 可以是秒数，也可以是 HTTP 日期。 */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}
