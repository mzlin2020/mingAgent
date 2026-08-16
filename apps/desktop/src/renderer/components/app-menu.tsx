import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 汉堡菜单（ADR-0037）：设置 / 帮助入口。
 * 新建会话等与 Home 页按钮重复的项不放这里。
 * 设置是模态，不离开当前会话（ADR-0075）。
 */
export function AppMenu(): ReactNode {
  const openSettings = useUi((state) => state.openSettings);
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

  const close = (): void => {
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className={cn(open && 'bg-surface-2 text-fg')}
        aria-label="菜单"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <HamburgerIcon />
      </Button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute left-0 z-20 mt-1.5 w-52 rounded-card border border-border bg-surface',
            'animate-pop-in p-1 shadow-pop',
          )}
        >
          <MenuItem
            label="设置"
            onClick={() => {
              close();
              openSettings();
            }}
          />
          <MenuItem label="帮助" muted onClick={close} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  muted,
  hint,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly muted?: boolean;
  readonly hint?: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-control px-2.5 py-1.5',
        'text-left text-body text-fg transition-colors hover:bg-surface-2',
      )}
    >
      <span className={muted === true ? 'text-muted' : undefined}>{label}</span>
      {hint !== undefined && <span className="text-micro text-faint">{hint}</span>}
    </button>
  );
}

function HamburgerIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
