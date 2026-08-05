import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ContentBlock, Message } from '@xm/contracts';
import { api } from './bridge.js';
import { Button, Card, Textarea } from './components/ui';
import { cn } from './lib/cn.js';
import { useUi } from './store.js';

/**
 * 最小三栏：会话列表 / 消息流 / 输入框。
 *
 * 消息全部来自 `useUi().session`，而那是 `reduce(events)` 的结果——
 * UI 里没有第二份 messages 数组。这条约束在这里看着像多余的严格，
 * 但它是"刷新一下内容就变了"这类问题唯一的根治办法（ADR-0015）。
 */
export function App(): ReactNode {
  const { currentId, session, busy, error } = useUi();
  const refreshSessions = useUi((s) => s.refreshSessions);
  const applyEvent = useUi((s) => s.applyEvent);

  useEffect(() => {
    void refreshSessions();
    // 订阅主进程推来的事件。总线在主进程，这里只是消费端（ADR-0013 不变量五）
    return api.onEvent(applyEvent);
  }, [refreshSessions, applyEvent]);

  return (
    <div className="flex h-screen bg-[var(--xm-bg)] text-[var(--xm-fg)]">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--xm-border)] px-4 py-2">
          <span className="truncate text-sm font-medium">
            {session?.title === '' || session === undefined ? '小明' : session.title}
          </span>
          <span className="text-xs text-[var(--xm-fg-muted)]">
            {session === undefined ? '' : `seq ${String(session.lastSeq)} · ${session.status}`}
          </span>
        </header>

        {error !== undefined && (
          <div className="border-b border-[var(--xm-border)] bg-[var(--xm-danger-bg)] px-4 py-2 text-xs">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {currentId === undefined ? (
            <p className="mt-16 text-center text-sm text-[var(--xm-fg-muted)]">
              左侧新建一个会话开始。M0-b 是空壳期：模型回复是脚本化的。
            </p>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {(session?.messages ?? []).map((m) => (
                <MessageView key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>

        <Composer disabled={currentId === undefined || busy} />
      </main>
    </div>
  );
}

function SessionList(): ReactNode {
  const { sessions, currentId } = useUi();
  const newSession = useUi((s) => s.newSession);
  const openSession = useUi((s) => s.openSession);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--xm-border)] bg-[var(--xm-surface-2)]">
      <div className="p-2">
        <Button className="w-full" onClick={() => void newSession()}>
          新会话
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-[var(--xm-fg-muted)]">还没有会话</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            onClick={() => void openSession(s.sessionId)}
            className={cn(
              'mb-1 w-full truncate rounded-md px-2 py-1.5 text-left text-sm',
              s.sessionId === currentId
                ? 'bg-[var(--xm-surface)] font-medium'
                : 'text-[var(--xm-fg-muted)] hover:bg-[var(--xm-surface)]',
            )}
          >
            {s.title ?? '未命名'}
          </button>
        ))}
      </div>
    </aside>
  );
}

function Composer({ disabled }: { readonly disabled: boolean }): ReactNode {
  const send = useUi((s) => s.send);
  const [text, setText] = useState('');

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    setText('');
    void send(trimmed);
  };

  return (
    <div className="border-t border-[var(--xm-border)] p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          disabled={disabled}
          placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit} disabled={disabled}>
          发送
        </Button>
      </div>
    </div>
  );
}

function MessageView({ message }: { readonly message: Message }): ReactNode {
  return (
    <Card className={message.role === 'user' ? 'bg-[var(--xm-surface-2)]' : ''}>
      <div className="mb-1 text-xs text-[var(--xm-fg-muted)]">
        {message.role === 'user' ? '你' : '小明'}
      </div>
      <div className="flex flex-col gap-2">
        {message.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </Card>
  );
}

function BlockView({ block }: { readonly block: ContentBlock }): ReactNode {
  switch (block.type) {
    case 'text':
      return <p className="whitespace-pre-wrap">{block.text}</p>;

    case 'thinking':
      return (
        <details className="text-xs text-[var(--xm-fg-muted)]">
          <summary className="cursor-pointer">思考过程</summary>
          <p className="mt-1 whitespace-pre-wrap">{block.text}</p>
        </details>
      );

    case 'tool_use':
      return (
        <div className="rounded border border-[var(--xm-border)] px-2 py-1 text-xs">
          <span className="font-medium">{block.name}</span>
          <pre className="mt-1 overflow-x-auto text-[var(--xm-fg-muted)]">
            {JSON.stringify(block.input)}
          </pre>
        </div>
      );

    case 'tool_result':
      return (
        <div
          className={cn(
            'rounded border px-2 py-1 text-xs',
            block.isError
              ? 'border-[var(--xm-danger)] bg-[var(--xm-danger-bg)]'
              : 'border-[var(--xm-border)]',
          )}
        >
          {block.content.map((c, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {c.type === 'text' ? c.text : `[${c.type}]`}
            </p>
          ))}
        </div>
      );

    default:
      // 未知块类型原样跳过，不让整条消息渲染失败——与事件流的处理保持一致
      return null;
  }
}
