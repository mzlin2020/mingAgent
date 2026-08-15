import type { AbortLike } from '../tool/types.js';

export interface MergedAbort {
  readonly signal: AbortLike;
  readonly dispose: () => void;
}

/**
 * 两个取消信号的并集：任一 abort 即 abort。
 *
 * 这是"环绕插件只许换一个**更短**的 signal"（ADR-0055 硬约束 3 / ADR-0062 §二.2）唯一
 * 需要的原语。用并集而不是替换，收紧就成了结构上的性质：插件递进来什么都只能多一个
 * abort 来源，递一个永不 abort 的 signal 什么也放宽不了，原始调用方的取消永远还在。
 */
export const mergeAbort = (left: AbortLike, right: AbortLike): MergedAbort => {
  const listeners = new Set<() => void>();
  let aborted = left.aborted || right.aborted;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    for (const listener of [...listeners]) listener();
    listeners.clear();
  };
  if (!aborted) {
    left.addEventListener('abort', onAbort);
    right.addEventListener('abort', onAbort);
  }
  return {
    signal: {
      get aborted(): boolean {
        return aborted;
      },
      // 已经 abort 之后注册不再回调，与真实 AbortSignal 一致：消费者要读 .aborted。
      addEventListener: (_type: 'abort', listener: () => void): void => {
        if (!aborted) listeners.add(listener);
      },
      removeEventListener: (_type: 'abort', listener: () => void): void => {
        listeners.delete(listener);
      },
    },
    dispose: (): void => {
      left.removeEventListener('abort', onAbort);
      right.removeEventListener('abort', onAbort);
      listeners.clear();
    },
  };
};
