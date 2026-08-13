import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 可折叠区块。
 *
 * 抽出来的理由很实在：`<details>/<summary>` 在三个地方各长了一个样——消息里的"思考过程"
 * 是一段裸的浅色文字，工具卡里的"查看结果"带一条上边框和自己的一套内边距，在途消息里的
 * "思考中…"又是第三种。三处都顶着浏览器默认的那个三角标，展开时没有任何过渡。
 *
 * 这里统一成一套：自绘的箭头（默认三角在不同平台上长得不一样）、一致的 hover、
 * 展开时箭头转 90°。
 */
export function Disclosure({
  label,
  defaultOpen = false,
  className,
  summaryClassName,
  children,
}: {
  readonly label: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
  readonly summaryClassName?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details className={cn('group', className)} open={defaultOpen}>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 text-muted transition-colors',
          'hover:text-fg [&::-webkit-details-marker]:hidden',
          summaryClassName,
        )}
      >
        <Chevron />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </summary>
      <div className="disclosure-content">
        <div className="disclosure-content__inner">{children}</div>
      </div>
    </details>
  );
}

function Chevron(): ReactNode {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-faint transition-transform group-open:rotate-90"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
