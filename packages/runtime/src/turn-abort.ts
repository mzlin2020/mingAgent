import type { AbortLike } from '@xm/kernel';

/**
 * 把两个取消信号并成一个：任一 abort 即 abort。
 *
 * 用在 Code Mode 的子调用上（地基复审四 C2）——那次调用同时受制于"这一轮被停"
 * 与"这段程序被终止"两件事，而 `ToolContext.signal` 只有一个位置。
 *
 * ── 为什么不用 `AbortSignal.any()` ──
 *
 * `deps.signal` 的类型是 `AbortLike`（内核刻意不引 DOM 类型，见 `port/abort.ts`），
 * 装配层给进来的**不一定**是真的 `AbortSignal`：测试里到处是手写的那三个成员。
 * `AbortSignal.any()` 只吃真货。
 *
 * ── 语义按 DOM 来 ──
 *
 * abort 之后再挂上来的监听器**不触发**，与 `AbortSignal` 一致。工具都是照着
 * `AbortSignal` 写的：先看 `aborted`，再挂监听。这里自作主张地补一次同步回调，
 * 反而会让那些工具在自己还没准备好时收到取消。
 */
export interface LinkedAbort {
  readonly signal: AbortLike;
  /**
   * 摘掉挂在上游那两个信号上的监听器。
   *
   * **必须调**：上游的 `deps.signal` 活得和整个回合一样久，而一段程序可以发起
   * 成百上千次子调用——不摘就是一条按调用次数增长的监听器泄漏。
   */
  dispose(): void;
}

export function linkAbort(upstream: AbortLike | undefined, run: AbortLike): LinkedAbort {
  if (upstream === undefined) return { signal: run, dispose: () => undefined };

  const listeners = new Set<() => void>();
  let fired = upstream.aborted || run.aborted;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    for (const listener of [...listeners]) listener();
    listeners.clear();
  };

  upstream.addEventListener('abort', fire);
  run.addEventListener('abort', fire);

  return {
    signal: {
      get aborted() {
        return upstream.aborted || run.aborted;
      },
      addEventListener: (_type, listener) => {
        if (!fired) listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    },
    dispose: () => {
      listeners.clear();
      upstream.removeEventListener('abort', fire);
      run.removeEventListener('abort', fire);
    },
  };
}
