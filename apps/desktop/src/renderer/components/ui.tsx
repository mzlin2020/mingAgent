import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 少量 shadcn 风格的基础组件。
 *
 * 刻意**手写而不是跑 shadcn CLI**：只需要几个组件，而 CLI 会带进一整套目录约定与十几个
 * 未用到的依赖。shadcn 的核心主张本来就是"组件是你的代码，不是你的依赖"——那这里就按它的
 * 主张办。真要成规模时再引入 CLI 不迟。
 *
 * 所有取值走 `styles.css` 的 `@theme` token，这里不出现任何字面色值或字面圆角。
 */

/**
 * ── variant 为什么是四个而不是两个 ──
 *
 * 上一版只有 `default` / `ghost`，于是审批卡上"允许本次 / 本会话都允许 / 拒绝 / 本会话都拒绝"
 * 四个按钮只能用两种权重表达三层语义——"拒绝"长得像一个次要链接，而它其实是与"允许"
 * 对等的一个决定。崩溃恢复横幅上的"继续 / 放弃"则相反，两个都是实心橙色，看不出主次。
 *
 * ── size 为什么必须有 ──
 *
 * 没有 size 的后果是每个调用点自己覆盖：`h-8 w-8 px-0`、`px-2 py-1 text-xs`、`gap-1.5 text-xs`
 * ……顶栏里几个控件因此高度各不相同。三档写在这里，调用点就不该再写高度。
 */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly size?: 'sm' | 'md' | 'icon';
};

const BUTTON_VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  // hover 不用 opacity：半透明按钮会透出底下滚动的正文，那是廉价感的主要来源之一
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'border border-danger-border text-danger hover:bg-danger-bg',
};

const BUTTON_SIZE: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-meta',
  md: 'h-9 gap-2 px-3.5 text-body',
  icon: 'h-8 w-8',
};

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-control font-medium',
        'transition-colors active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-45',
        BUTTON_SIZE[size],
        BUTTON_VARIANT[variant],
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
        'w-full resize-none rounded-control border border-border bg-surface',
        'px-3 py-2 text-body outline-none placeholder:text-faint',
        'focus:border-accent',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 带边框的容器。
 *
 * ── 边框在这一版里是有含义的 ──
 *
 * 助手的回复不再套卡片（见 `message-stream.tsx`）。留下来用 `Card` 的都是"机器干的事"：
 * 工具调用、终端面板、审批请求。所以一个框出现在正文里就代表"这不是模型在说话"，
 * 而不是像上一版那样每条消息都有一个同样粗细的框、边框什么也不区分。
 */
export function Card({
  className,
  tone = 'default',
  children,
}: {
  readonly className?: string;
  readonly tone?: 'default' | 'accent' | 'danger';
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        'rounded-card border p-3.5 text-body',
        tone === 'accent' && 'border-accent bg-surface',
        tone === 'danger' && 'border-danger-border bg-danger-bg',
        tone === 'default' && 'border-border bg-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}
