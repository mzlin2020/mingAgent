import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 少量 shadcn 风格的基础组件。
 *
 * 刻意**手写而不是跑 shadcn CLI**：M0-b 只需要三个组件，而 CLI 会带进一整套
 * 目录约定与十几个未用到的依赖。shadcn 的核心主张本来就是"组件是你的代码，
 * 不是你的依赖"——那这里就按它的主张办。真要成规模时再引入 CLI 不迟。
 *
 * 主题走 CSS 变量（见 styles.css），调性贴近 Claude Code 桌面端。
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'default' | 'ghost';
};

export function Button({ className, variant = 'default', ...props }: ButtonProps): ReactNode {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        variant === 'default'
          ? 'bg-[var(--xm-accent)] text-white hover:opacity-90'
          : 'text-[var(--xm-fg-muted)] hover:bg-[var(--xm-surface-2)]',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-[var(--xm-border)] bg-[var(--xm-surface)]',
        'px-3 py-2 text-sm outline-none placeholder:text-[var(--xm-fg-muted)]',
        'focus:border-[var(--xm-accent)]',
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--xm-border)] bg-[var(--xm-surface)] p-3 text-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
