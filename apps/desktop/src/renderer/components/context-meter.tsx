import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CONTEXT_METER_SIZE_PX } from '../lib/layout.js';
import {
  formatTokenCount,
  occupancyFillRatio,
  occupancyOverCapacity,
  OCCUPANCY_SEGMENTS,
} from '../lib/occupancy.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 发送键旁的 14px 占用环（M3.5-f）。点开三段分解。
 *
 * 读数来自主进程 sidecar，不是渲染层自己估的——估算器跟压缩路径是同一份。
 */
export function ContextMeter(): ReactNode {
  const occupancy = useUi((s) => s.occupancy);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /*
   * 还没发过消息时环是空的，看起来像发送键旁边的 loading。
   * 有读数再出现——aria 原来就写着「发送后显示」。
   */
  if (occupancy === undefined) return null;

  const ratio = occupancyFillRatio(occupancy);
  const over = occupancyOverCapacity(occupancy);
  const percent = Math.round(ratio * 100);
  const size = CONTEXT_METER_SIZE_PX;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className={cn(
          'context-meter flex items-center justify-center rounded-chip',
          'text-muted transition-colors hover:bg-surface-2 hover:text-fg',
          open && 'bg-surface-2 text-fg',
        )}
        aria-label={`上下文占用 ${String(percent)}%`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${String(size)} ${String(size)}`}
          className="context-meter__ring block"
          aria-hidden="true"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="text-border"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${String(c * ratio)} ${String(c)}`}
            transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
            className={cn('context-meter__fill', over ? 'text-danger' : 'text-accent')}
          />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="上下文占用分解"
          className={cn(
            'absolute bottom-full right-0 z-20 mb-1.5 w-56 rounded-card border border-border bg-surface',
            'animate-pop-in p-2.5 shadow-pop',
          )}
        >
          <p className="mb-2 text-meta text-fg">
            {formatTokenCount(occupancy.totalTokens)} / {formatTokenCount(occupancy.capacityTokens)}
          </p>
          <ul className="flex flex-col gap-1.5">
            {OCCUPANCY_SEGMENTS.map((seg) => {
              const tokens = occupancy[seg.key];
              const share =
                occupancy.totalTokens === 0 ? 0 : tokens / occupancy.totalTokens;
              return (
                <li key={seg.key}>
                  <div className="flex items-baseline justify-between gap-2 text-meta">
                    <span className="text-muted">{seg.label}</span>
                    <span className="font-mono text-fg">{formatTokenCount(tokens)}</span>
                  </div>
                  <div className="mt-0.5 h-0.5 overflow-hidden rounded-chip bg-surface-2">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${String(Math.round(share * 100))}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
