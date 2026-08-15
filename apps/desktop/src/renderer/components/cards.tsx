import { useState, type ReactNode } from 'react';
import type { ToolCard, ToolCardKind } from '@xm/contracts';
import { Disclosure } from './disclosure.js';
import { Button } from './ui.js';
import { cn } from '../lib/cn.js';
import type { CardActionInvoke, CardRenderer, CardRendererProps } from '../lib/card-registry.js';
import { registerRenderer } from '../lib/card-registry.js';

/**
 * 四种内建卡片的渲染器（ADR-0058）。
 *
 * 这个文件里**没有任何工具名**。它认识的全部东西是 `card.kind` 这四个取值，
 * 以及"卡片上可能有几个按钮"。新增一个工具、乃至一个三方插件的工具，
 * 只要它的投影产出这四种之一，就能直接出卡片、直接可交互。
 */

/** 单个 hunk 最多渲染多少行。超长 diff 铺开会把对话本身淹掉，也拖慢渲染 */
export const MAX_RENDERED_DIFF_LINES = 400;

export function boundedDiff(patch: string): {
  readonly lines: readonly string[];
  readonly truncated: boolean;
} {
  const lines = patch.split('\n');
  return {
    lines: lines.slice(0, MAX_RENDERED_DIFF_LINES),
    truncated: lines.length > MAX_RENDERED_DIFF_LINES,
  };
}

/** 动作按钮条。`selection` 类动作把当前选择集当载荷送上去，其余送空对象 */
function CardActions({
  card,
  busy,
  selected,
  onAction,
}: {
  readonly card: ToolCard;
  readonly busy: boolean;
  readonly selected: readonly string[];
  readonly onAction: CardActionInvoke;
}): ReactNode {
  if (card.actions === undefined || card.actions.length === 0) return null;
  return (
    <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
      {card.actions.map((action) => (
        <Button
          key={action.actionId}
          size="sm"
          variant={action.emphasis === 'primary' ? 'primary' : 'ghost'}
          disabled={busy || (action.payload === 'selection' && selected.length === 0)}
          onClick={() => {
            onAction(action.actionId, action.payload === 'selection' ? { selected } : {});
          }}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

const Generic = ({ card, busy, onAction }: CardRendererProps): ReactNode => {
  if (card.kind !== 'generic') return null;
  return (
    <>
      {card.body !== undefined && card.body !== '' && (
        <Disclosure
          className="border-t border-border"
          summaryClassName="px-3 py-1.5"
          label={`查看结果（${String(card.body.split('\n').length)} 行）`}
        >
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-3 pb-2.5 font-mono text-muted">
            {card.body}
          </pre>
        </Disclosure>
      )}
      {card.locations !== undefined && card.locations.length > 0 && (
        <ul className="border-t border-border px-3 py-1.5 text-meta text-muted">
          {card.locations.slice(0, 20).map((location, index) => (
            <li key={index} className="truncate font-mono">
              {location.path}
              {location.line === undefined ? '' : `:${String(location.line)}`}
            </li>
          ))}
        </ul>
      )}
      <CardActions card={card} busy={busy} selected={[]} onAction={onAction} />
    </>
  );
};

const Terminal = ({ card, busy, onAction }: CardRendererProps): ReactNode => {
  if (card.kind !== 'terminal') return null;
  return (
    <>
      <pre className="overflow-x-auto border-t border-border bg-surface-2 px-3 py-1.5 font-mono text-meta">
        $ {card.command}
      </pre>
      {card.output !== undefined && card.output !== '' && (
        <Disclosure
          className="border-t border-border"
          summaryClassName="px-3 py-1.5"
          label={
            card.exitCode === undefined || card.exitCode === 0
              ? '查看输出'
              : `查看输出（退出码 ${String(card.exitCode)}）`
          }
        >
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-3 pb-2.5 font-mono text-muted">
            {card.output}
          </pre>
        </Disclosure>
      )}
      <CardActions card={card} busy={busy} selected={[]} onAction={onAction} />
    </>
  );
};

const Search = ({ card, busy, onAction }: CardRendererProps): ReactNode => {
  if (card.kind !== 'search') return null;
  return (
    <>
      <div className="border-t border-border px-3 py-1.5 text-meta">
        {(card.groups ?? []).slice(0, 50).map((group) => (
          <div key={group.path} className="mb-1.5 last:mb-0">
            <div className="truncate font-mono text-muted">{group.path}</div>
            {group.matches.slice(0, 20).map((match, index) => (
              <div key={index} className="truncate pl-3 font-mono text-faint">
                {match.line === undefined ? '' : `${String(match.line)}: `}
                {match.text}
              </div>
            ))}
          </div>
        ))}
        {(card.paths ?? []).slice(0, 200).map((path) => (
          <div key={path} className="truncate font-mono text-muted">
            {path}
          </div>
        ))}
        {card.truncated && <div className="text-faint">… 结果已截断</div>}
      </div>
      <CardActions card={card} busy={busy} selected={[]} onAction={onAction} />
    </>
  );
};

/**
 * diff 卡片。**逐块可选**——选择项 id 由卡片自己给出（`hunkId`），
 * 渲染层不知道它对应哪一条替换、更不知道会调用哪个工具。
 *
 * 勾选框只在卡片声明了 `selection` 动作时出现：一张只用来展示改动的 diff 卡片
 * 不该长得像一个待办事项。
 */
const Diff = ({ card, busy, onAction }: CardRendererProps): ReactNode => {
  const selectable =
    card.kind === 'diff' && (card.actions ?? []).some((action) => action.payload === 'selection');
  const allIds =
    card.kind === 'diff'
      ? card.files.flatMap((file) =>
          file.kind === 'hunks' ? file.hunks.map((hunk) => hunk.hunkId) : [],
        )
      : [];
  const [selected, setSelected] = useState<ReadonlySet<string> | undefined>(undefined);
  if (card.kind !== 'diff') return null;
  const picked = selected ?? new Set(allIds);

  const toggle = (hunkId: string, on: boolean): void => {
    const next = new Set(picked);
    if (on) next.add(hunkId);
    else next.delete(hunkId);
    setSelected(next);
  };

  return (
    <>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        {card.files.map((file) => (
          <div key={file.path} className="min-w-0">
            <div className="mb-1 truncate font-mono text-meta text-muted">{file.path}</div>
            {file.kind === 'full' ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap bg-surface-2 p-2 font-mono text-meta">
                {file.oldText === null ? '（新建文件）\n' : ''}
                {file.newText}
              </pre>
            ) : (
              file.hunks.map((hunk) => {
                const view = boundedDiff(hunk.patch);
                return (
                  <label key={hunk.hunkId} className="mb-1.5 flex items-start gap-2 last:mb-0">
                    {selectable && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(hunk.hunkId)}
                        onChange={(event) => {
                          toggle(hunk.hunkId, event.currentTarget.checked);
                        }}
                      />
                    )}
                    <pre className="min-w-0 flex-1 overflow-x-auto bg-surface-2 p-2 font-mono text-meta">
                      {view.lines.join('\n')}
                      {view.truncated
                        ? `\n… diff 过大，仅显示前 ${String(MAX_RENDERED_DIFF_LINES)} 行`
                        : ''}
                    </pre>
                  </label>
                );
              })
            )}
          </div>
        ))}
      </div>
      <CardActions card={card} busy={busy} selected={[...picked]} onAction={onAction} />
    </>
  );
};

/**
 * 四种内建渲染器。装配一次，不随组件生命周期反复注册。
 *
 * 表的类型是 `Record<ToolCardKind, …>`——**编译期穷尽**：往闭集里加一种卡片却忘了画它，
 * 这里当场编译失败，而不是等到某个用户的会话里出现一张只剩摘要的卡片。
 */
const BUILTIN: Record<ToolCardKind, CardRenderer> = {
  generic: Generic,
  terminal: Terminal,
  diff: Diff,
  search: Search,
};

export const installBuiltinRenderers = (): void => {
  for (const [kind, renderer] of Object.entries(BUILTIN)) {
    registerRenderer(kind as ToolCardKind, renderer);
  }
};

/** 供样式复用：失败态的边框与底色 */
export const cardTone = (failed: boolean): string =>
  cn('overflow-hidden rounded-control border text-meta', failed ? 'border-danger-border' : 'border-border');
