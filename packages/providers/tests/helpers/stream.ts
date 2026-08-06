/** 把一段文本变成字节流。`chunkSize` 控制分片边界——SSE 解析的坑几乎都在分片上 */
export function streamOf(text: string, chunkSize = Number.MAX_SAFE_INTEGER): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** 一个永远不结束的流，直到 `cancel()` 被调用。取消用例靠它 */
export function hangingStream(prefix = ''): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix !== '') controller.enqueue(new TextEncoder().encode(prefix));
    },
    pull() {
      // 永不 enqueue、永不 close：读取方会一直挂在 read() 上
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

/**
 * 模拟真 `fetch` 的取消行为：signal 一 abort，**正文读取当场抛**。
 *
 * 这与"外部调 stream.cancel()"不是一回事——读取方持有 reader 锁时 cancel 会失败。
 * 真实的 undici 走的是 error 这条路，用例也必须走同一条，否则测的是一个不存在的形状。
 */
export function abortableStream(
  signal: AbortSignalLike,
  prefix = '',
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix !== '') controller.enqueue(new TextEncoder().encode(prefix));
      signal.addEventListener('abort', () => {
        controller.error(new Error('The operation was aborted'));
      });
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
  });
}

/** 最小的 AbortLike，用来驱动取消桥接 */
export function abortLike(): { signal: AbortSignalLike; abort: () => void } {
  const listeners = new Set<() => void>();
  const signal: AbortSignalLike = {
    aborted: false,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    abort: () => {
      signal.aborted = true;
      for (const l of [...listeners]) l();
    },
  };
}

export interface AbortSignalLike {
  aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
