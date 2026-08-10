import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';

/**
 * 汉堡菜单（ADR-0037）：设置 / 帮助入口。
 * 新建会话等与 Home 页按钮重复的项不放这里。
 * 设置实体页仍归 M3，这里只占位。
 */
export function AppMenu(): ReactNode {
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
        className="h-8 w-8 px-0"
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
          className="absolute left-0 z-20 mt-1 w-52 rounded-md border border-[var(--xm-border)] bg-[var(--xm-surface)] py-1 shadow-sm"
        >
          <MenuItem label="设置" muted hint="M3" onClick={close} />
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
      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-[var(--xm-fg)] hover:bg-[var(--xm-surface-2)]"
    >
      <span className={muted === true ? 'text-[var(--xm-fg-muted)]' : undefined}>{label}</span>
      {hint !== undefined && (
        <span className="text-[10px] text-[var(--xm-fg-muted)]">{hint}</span>
      )}
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
