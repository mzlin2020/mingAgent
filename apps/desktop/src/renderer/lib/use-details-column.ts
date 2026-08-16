import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  CENTER_MIN,
  DETAILS_DEFAULT,
  type DetailsPref,
  clampDetailsWidth,
  resolveDetailsLayout,
} from './columns.js';
import { readDetailsPref, writeDetailsOpen, writeDetailsWidth } from './ui-prefs.js';

export interface DetailsColumn {
  readonly frameRef: RefObject<HTMLDivElement | null>;
  readonly width: number;
  readonly prefWidth: number;
  readonly collapsed: boolean;
  readonly openPref: boolean;
  readonly resizing: boolean;
  readonly toggleOpen: () => void;
  readonly beginResize: (event: ReactPointerEvent<HTMLElement>) => void;
}

function initialViewport(): number {
  if (typeof window === 'undefined') return CENTER_MIN + DETAILS_DEFAULT;
  return window.innerWidth;
}

function initialPref(): DetailsPref {
  if (typeof localStorage === 'undefined') {
    return { width: DETAILS_DEFAULT, open: false };
  }
  return readDetailsPref(localStorage);
}

function attachResize(
  handle: HTMLElement,
  frame: HTMLElement,
  pointerId: number,
  startWidth: number,
  onDraft: (width: number) => void,
  onCommit: (width: number) => void,
): void {
  handle.setPointerCapture(pointerId);
  let nextWidth = startWidth;
  const onMove = (move: PointerEvent): void => {
    nextWidth = clampDetailsWidth(frame.getBoundingClientRect().right - move.clientX);
    onDraft(nextWidth);
  };
  const onUp = (): void => {
    onCommit(nextWidth);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

/**
 * 详情栏的视口测量、偏好与拖拽。自动关闭只改这一帧的投影，不写 `localStorage`。
 */
export function useDetailsColumn(): DetailsColumn {
  const frameRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(initialViewport);
  const [pref, setPref] = useState(initialPref);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const el = frameRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setViewport(next);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const layout = resolveDetailsLayout(viewport, pref);

  const toggleOpen = useCallback((): void => {
    setPref((current) => writeDetailsOpen(localStorage, !current.open));
  }, []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const frame = frameRef.current;
    if (frame === null) return;
    event.preventDefault();
    setResizing(true);
    attachResize(
      event.currentTarget,
      frame,
      event.pointerId,
      pref.width,
      (width) => {
        setPref((current) => ({ ...current, width }));
      },
      (width) => {
        writeDetailsWidth(localStorage, width);
        setResizing(false);
      },
    );
  }, [pref.width]);

  return {
    frameRef,
    width: layout.width,
    prefWidth: pref.width,
    collapsed: layout.collapsed,
    openPref: pref.open,
    resizing,
    toggleOpen,
    beginResize,
  };
}
