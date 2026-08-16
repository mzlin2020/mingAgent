import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { Checkpoint } from '@xm/kernel';
import type { Todo } from '@xm/contracts';
import { CheckpointPanel } from './checkpoint-panel.js';
import { DetailsResizeHandle } from './details-resize-handle.js';
import { DetailsView } from './details-view.js';
import { LiveCalls } from './live-views.js';
import { TerminalPanel } from './terminal-panel.js';
import { TodoPanel } from './todo-panel.js';
import {
  detailsScrollHost,
  lookupCallMaterial,
  nextDetailsTab,
  type DetailsTab,
} from '../lib/call-material.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 右栏：详情 + 工作区（M3.5-d / ADR-0074）。
 *
 * 关闭 = 零宽但保持挂载。两个 tab 的内容也都保持挂载，只用 `hidden` 切可见性——
 * 切 tab 或关栏都不能把滚动位置和展开状态卸掉。
 */
export function WorkbenchPanel({
  sessionId,
  todos,
  checkpoints,
  width,
  innerWidth,
  collapsed,
  resizing,
  onResizeStart,
}: {
  readonly sessionId: string;
  readonly todos: readonly Todo[];
  readonly checkpoints: readonly Checkpoint[];
  readonly width: number;
  readonly innerWidth: number;
  readonly collapsed: boolean;
  readonly resizing: boolean;
  readonly onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  const selectedCallId = useUi((s) => s.selectedCallId);
  const messages = useUi((s) => s.session?.messages ?? []);
  const dispatches = useUi((s) => s.dispatches);
  const [tab, setTab] = useState<DetailsTab>('workspace');
  const prevSelected = useRef(selectedCallId);

  useEffect(() => {
    setTab((current) => nextDetailsTab(prevSelected.current, selectedCallId, current));
    prevSelected.current = selectedCallId;
  }, [selectedCallId]);

  const material =
    selectedCallId === undefined
      ? undefined
      : lookupCallMaterial(messages, dispatches, selectedCallId);
  const mounted = detailsScrollHost(collapsed);
  const style = {
    '--xm-details-width': `${String(width)}px`,
    '--xm-details-inner-width': `${String(innerWidth)}px`,
  } as CSSProperties;

  return (
    <aside
      className="workspace-panel shrink-0"
      style={style}
      data-resizing={resizing ? '' : undefined}
      data-scroll-host={mounted}
      {...(collapsed ? { 'data-details-collapsed': '' } : {})}
      aria-hidden={collapsed}
      inert={collapsed}
      aria-label="详情与工作区"
    >
      {!collapsed && <DetailsResizeHandle onBegin={onResizeStart} />}
      <div className="workspace-panel__inner flex h-full flex-col bg-surface">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2" role="tablist">
          <PanelTab
            selected={tab === 'details'}
            onSelect={() => {
              setTab('details');
            }}
          >
            详情
          </PanelTab>
          <PanelTab
            selected={tab === 'workspace'}
            onSelect={() => {
              setTab('workspace');
            }}
          >
            工作区
          </PanelTab>
        </div>
        <div
          hidden={tab !== 'details'}
          inert={tab !== 'details'}
          role="tabpanel"
          data-details-scroll
          className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable]"
        >
          <DetailsView material={material} />
        </div>
        <div
          hidden={tab !== 'workspace'}
          inert={tab !== 'workspace'}
          role="tabpanel"
          className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable]"
        >
          <div className="flex flex-col gap-3">
            <TodoPanel todos={todos} />
            <LiveCalls />
            <TerminalPanel />
            <CheckpointPanel sessionId={sessionId} checkpoints={checkpoints} />
          </div>
        </div>
      </div>
    </aside>
  );
}

function PanelTab({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        'panel-tab relative h-11 px-3',
        selected ? 'font-medium text-fg' : 'text-muted hover:text-fg',
      )}
      onClick={onSelect}
    >
      {children}
      <span
        className={cn(
          'absolute inset-x-3 bottom-0 h-0.5 rounded-chip',
          selected ? 'bg-accent' : 'bg-transparent',
        )}
        aria-hidden="true"
      />
    </button>
  );
}
