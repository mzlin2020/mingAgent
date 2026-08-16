import type { PointerEvent, ReactNode } from 'react';

/**
 * 8px 命中带跨在列边界上（`margin-left: -4px`），中央 12×32 药丸。
 * 默认透明，指针进入详情栏或把手时才显形（样式在 `styles.css`）。
 */
export function DetailsResizeHandle({
  onBegin,
}: {
  readonly onBegin: (event: PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  return (
    <div
      className="details-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右栏宽度"
      onPointerDown={onBegin}
    >
      <span className="details-handle__pill" aria-hidden="true" />
    </div>
  );
}
