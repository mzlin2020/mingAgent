import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * shadcn 的惯例：条件拼接 + Tailwind 冲突消解（后者胜）。
 *
 * ── 为什么不能直接用裸的 `twMerge` ──
 *
 * `styles.css` 把 Tailwind 自带的 color / radius / text / shadow 命名空间清零换成了自己的档位，
 * 而 tailwind-merge 的冲突消解是**照着默认档位表**判断的。不告诉它这套新表，
 * `cn('rounded-card', 'rounded-control')` 会两个都留下（它不认识这两个后缀，当成不同的类），
 * 而 `cn('text-body', 'text-muted')` 会误判成两个文字颜色互相冲突，把字号那个丢掉。
 *
 * 所以这张表必须和 `styles.css` 的 `@theme` 一一对应——加 token 时两处一起改。
 */
const twMerge = extendTailwindMerge({
  override: {
    theme: {
      color: [
        'transparent',
        'current',
        'inherit',
        'canvas',
        'surface',
        'surface-2',
        'border',
        'border-strong',
        'fg',
        'muted',
        'faint',
        'accent',
        'accent-hover',
        'accent-weak',
        'on-accent',
        'danger',
        'danger-bg',
        'danger-border',
        'terminal-bg',
        'terminal-fg',
      ],
      radius: ['card', 'control', 'chip'],
      text: ['micro', 'meta', 'body', 'title'],
      shadow: ['pop', 'raise'],
      font: ['sans', 'mono'],
      ease: ['out-soft'],
      animate: ['pop-in'],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
