import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { CallId, ContentBlock, ToolCard as Card } from '@xm/contracts';
import { cn } from '../lib/cn.js';
import { toolRowTitle } from '../lib/tool-row.js';
import { formatDuration } from '../lib/turn-stats.js';
import { rendererFor } from '../lib/card-registry.js';
import { childDispatches } from '../lib/call-material.js';
import { useUi } from '../store.js';
import { cardTone } from './cards.js';
import { DispatchRow } from './dispatch-row.js';

/**
 * 工具调用的 24px 单行（M3.5-c）。收起是行，展开才是四种卡片。
 *
 * 点这一行 = 选中并打开右栏详情；点行首箭头 = 就地展开。两个动作分开。
 * 展开后若这次调用有子调用投影，每条是一行、可点（不靠工具名识别）。
 * 图标与摘要只来自卡片投影，这里仍然不认识任何具体工具。
 */

export function ToolCallRow({
  callId,
  name,
  input,
  result,
}: {
  readonly callId: CallId;
  readonly name: string;
  readonly input: unknown;
  readonly result: Extract<ContentBlock, { type: 'tool_result' }> | undefined;
}): ReactNode {
  const pair = useUi((s) => s.cards.get(callId));
  const invoke = useUi((s) => s.cardAction);
  const busy = useUi((s) => s.busy);
  const selected = useUi((s) => s.selectedCallId === callId);
  const selectCall = useUi((s) => s.selectCall);
  const dispatches = useUi((s) => s.dispatches);
  const startedAt = useUi((s) => s.session?.runningCalls.get(callId)?.startedAt);
  const liveNote = useUi((s) => s.live.calls.get(callId)?.message);
  const failed = result?.isError === true;
  const pending = result === undefined;
  const card = (pending ? pair?.call : pair?.result ?? pair?.call) ?? fallbackCard(name, input);
  const Renderer = rendererFor(card.kind);
  const [expanded, setExpanded] = useState(false);
  const elapsed = useElapsed(pending ? startedAt : undefined);
  const children = childDispatches(dispatches, callId);

  const onToggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    setExpanded((open) => !open);
  };

  return (
    <div>
      <div
        className="tool-row"
        role="button"
        tabIndex={0}
        data-selected={selected ? '' : undefined}
        data-pending={pending ? '' : undefined}
        data-failed={failed ? '' : undefined}
        aria-selected={selected}
        onClick={() => {
          selectCall(callId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectCall(callId);
          }
        }}
      >
        <button
          type="button"
          className="tool-row__toggle"
          aria-label={expanded ? '收起这次调用' : '展开这次调用'}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <RowChevron />
        </button>
        <KindIcon kind={card.kind} />
        <span className="tool-row__name">{toolRowTitle(card)}</span>
        <span className="tool-row__dots" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="tool-row__summary">{liveNote ?? card.summary}</span>
        {elapsed !== undefined && (
          <span className="tool-row__elapsed">{formatDuration(elapsed)}</span>
        )}
      </div>
      {expanded && children.length > 0 && (
        <div className="tool-row__children">
          {children.map((item) => (
            <DispatchRow key={item.callId} item={item} />
          ))}
        </div>
      )}
      {expanded && Renderer !== undefined && (
        <div className={cn(cardTone(failed), 'mt-1')}>
          <Renderer
            card={card}
            pending={pending}
            failed={failed}
            busy={busy}
            onAction={(actionId, payload) => {
              void invoke(callId, actionId, payload);
            }}
          />
        </div>
      )}
    </div>
  );
}

function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, now - startedAt);
}

const fallbackCard = (name: string, input: unknown): Card => ({
  kind: 'generic',
  title: name,
  summary: `${name} ${summarize(input)}`.trim().slice(0, 400),
});

function summarize(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  const record = input as Record<string, unknown>;
  const path = record.path;
  if (typeof path === 'string') return path;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function RowChevron(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KindIcon({ kind }: { readonly kind: Card['kind'] }): ReactNode {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    className: 'tool-row__icon',
  };
  if (kind === 'terminal') {
    return (
      <svg {...common}>
        <path d="M4 7h16M8 12l3 3-3 3M13 18h7" />
      </svg>
    );
  }
  if (kind === 'diff') {
    return (
      <svg {...common}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="4" width="7" height="7" rx="1.2" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" />
      <rect x="13" y="13" width="7" height="7" rx="1.2" />
    </svg>
  );
}
