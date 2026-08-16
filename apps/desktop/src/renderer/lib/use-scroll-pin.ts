import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isPinnedToBottom } from './scroll-pin.js';

/**
 * 共享滚动容器的贴底。Home 要回到顶，对话要贴底；两者共用一个 ref。
 *
 * `pinned` 必须是 state 不是 ref：回到底部按钮要跟着它显隐。
 */

export function useScrollPin(opts: {
  readonly resetKey: string;
  readonly mode: 'pin' | 'top';
  readonly contentKey: string;
}): {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly scrollToBottom: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback((): void => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (opts.mode === 'top') {
      if (el !== null) el.scrollTop = 0;
      pinnedRef.current = true;
      setPinned(true);
      return;
    }
    pinnedRef.current = true;
    setPinned(true);
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [opts.resetKey, opts.mode]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onScroll = (): void => {
      const next = isPinnedToBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
      pinnedRef.current = next;
      setPinned(next);
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [opts.resetKey, opts.mode]);

  useEffect(() => {
    if (opts.mode !== 'pin') return;
    const el = ref.current;
    if (el === null || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [opts.contentKey, opts.mode]);

  return { ref, pinned, scrollToBottom };
}
