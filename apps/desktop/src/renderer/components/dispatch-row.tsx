import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { CodeDispatchView } from '../../shared/code-dispatch.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * Code Mode 子调用的一行。挂在父工具行展开之后，点它 = 选中（右栏详情）。
 *
 * 标题用事件里的 `name`，那是审计事实，不是渲染层白名单里的工具知识。
 * 这个文件仍然不出现任何内建工具名。
 */
export function DispatchRow({ item }: { readonly item: CodeDispatchView }): ReactNode {
  const selected = useUi((s) => s.selectedCallId === item.callId);
  const selectCall = useUi((s) => s.selectCall);
  const summary = item.ok ? '已执行' : (item.error?.message ?? '失败');

  const select = (event: MouseEvent | KeyboardEvent): void => {
    event.stopPropagation();
    selectCall(item.callId);
  };

  return (
    <div
      className={cn('tool-row tool-row--dispatch')}
      role="button"
      tabIndex={0}
      data-selected={selected ? '' : undefined}
      data-failed={item.ok ? undefined : ''}
      aria-selected={selected}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(event);
        }
      }}
    >
      <span className="tool-row__name">{item.name}</span>
      <span className="tool-row__summary">{summary}</span>
    </div>
  );
}
