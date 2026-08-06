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
  const refreshStatus = useUi((s) => s.refreshStatus);
  const applyEvent = useUi((s) => s.applyEvent);

  useEffect(() => {
    void refreshSessions();
    void refreshStatus();
    // 订阅主进程推来的事件。总线在主进程，这里只是消费端（ADR-0013 不变量五）
    return api.onEvent(applyEvent);
  }, [refreshSessions, refreshStatus, applyEvent]);

  return (
    <div className="flex h-screen bg-[var(--xm-bg)] text-[var(--xm-fg)]">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--xm-border)] px-4 py-2">
          <span className="truncate text-sm font-medium">
            {session?.title === '' || session === undefined ? '小明' : session.title}
          </span>
          <UsageBadge />
        </header>

        {error !== undefined && (
          <div className="border-b border-[var(--xm-border)] bg-[var(--xm-danger-bg)] px-4 py-2 text-xs">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {currentId === undefined ? (
            <p className="mt-16 text-center text-sm text-[var(--xm-fg-muted)]">左侧新建一个会话开始。</p>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              <SetupBanner />
              <NoticeBanner />
              <UntrustedBanner />
              {(session?.messages ?? []).map((m) => (
                <MessageView key={m.id} message={m} />
              ))}
              <LiveMessage />
            </div>
          )}
        </div>

        {/*
          `busy` 是"这次 IPC 还没返回"，`session.status === 'running'` 是"事件流说它在跑"。
          停止按钮认后者：前者在网络往返期间也为真，而那时还没有任何东西可停。
        */}
        <Composer
          disabled={currentId === undefined || busy}
          running={session?.status === 'running'}
        />
      </main>
    </div>
  );
}

/**
 * 用量与成本。
 *
 * ── 未计价的回合必须显示出来，不能并进那个数字 ──
 *
 * 仓库里不带默认价格表（`contracts/model/price.ts` 说明了为什么：带一份就等于发布一个
 * 会过期的事实）。于是"$0.00"有两种可能：真没花钱，或者我们不知道花了多少。
 * 把后者显示成前者，用户就拿到了一个自信的错数字——比诚实地说"未计价"糟糕得多。
 */
function UsageBadge(): ReactNode {
  const session = useUi((s) => s.session);
  if (session === undefined) return null;

  const { usage, costUsd, unpricedTurns } = session.usage;
  const tokens = usage.inputTokens + usage.outputTokens;

  return (
    <span className="text-xs text-[var(--xm-fg-muted)]">
      {tokens > 0 && `${tokens.toLocaleString()} tok · `}
      {unpricedTurns > 0
        ? `≥ $${costUsd.toFixed(4)}（${String(unpricedTurns)} 次未计价）`
        : costUsd > 0 && `$${costUsd.toFixed(4)} · `}
      {`seq ${String(session.lastSeq)} · ${session.status}`}
    </span>
  );
}

/**
 * 还没配好模型时的引导 —— 也是本轮唯一的密钥录入口。
 *
 * 刻意做成一条横幅而不是一个设置页：配置中心是 M3 的交付项，现在长出半个来，
 * 到时候要么推翻要么带着走。横幅只干一件事——让"没有 key"这个状态有出路。
 *
 * 录入框是 `type="password"`，且**没有任何回显**：主进程那边也没有读密钥的通道
 * （`shared/channels.ts` 的注释），所以这里显示不出已存的 key，只显示"已配置"。
 */
function SetupBanner(): ReactNode {
  const status = useUi((s) => s.status);
  const setApiKey = useUi((s) => s.setApiKey);
  const [key, setKey] = useState('');

  if (status === undefined || status.providerReady) return null;

  const blocked = status.secretBackend === 'plaintext-unavailable';

  return (
    <div className="rounded-md border border-[var(--xm-border)] bg-[var(--xm-surface-2)] px-3 py-2 text-xs">
      <p className="font-medium">还没有配置模型</p>
      <p className="mt-1 text-[var(--xm-fg-muted)]">
        当前模型：<span className="font-mono">{status.providerId}</span> /{' '}
        <span className="font-mono">{status.model}</span>
        {status.hasApiKey && '（配置里有密钥引用，但取不到值）'}
      </p>

      {blocked ? (
        <p className="mt-2 text-[var(--xm-fg-muted)]">
          系统钥匙串不可用，因此**无法保存密钥**——不会退化成明文保存。
          在 Linux 上通常是缺少 gnome-keyring 或 kwallet，装好并启动后重开小明。
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={key}
            placeholder={`${status.providerId} 的 API key`}
            onChange={(e) => {
              setKey(e.target.value);
            }}
            className="min-w-0 flex-1 rounded border border-[var(--xm-border)] bg-[var(--xm-surface)] px-2 py-1 font-mono"
          />
          <Button
            disabled={key.trim() === ''}
            onClick={() => {
              const value = key.trim();
              setKey('');
              void setApiKey(status.providerId, value);
            }}
          >
            保存到钥匙串
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * 会话里的 notice —— 目前主要是密钥后端降级与配置问题。
 *
 * 读的是 `session.notices`（reduce 出来的），不是某个 UI 局部状态：
 * 这些事在事件流里留了痕，三个月后回看这个会话仍然看得到"当时密钥存不了"。
 */
function NoticeBanner(): ReactNode {
  const session = useUi((s) => s.session);
  const notices = session?.notices ?? [];
  if (notices.length === 0) return null;

  return (
    <div className="rounded-md border border-[var(--xm-border)] bg-[var(--xm-surface-2)] px-3 py-2 text-xs">
      {notices.map((n, i) => (
        <p key={i} className={n.level === 'warn' ? '' : 'text-[var(--xm-fg-muted)]'}>
          {n.message}
        </p>
      ))}
    </div>
  );
}

/**
 * 在途消息（ADR-0021）—— 模型正在打字的那一条。
 *
 * 它渲染的是 `live`，不是 `session.messages`。两者在时间上互斥：`message.end` 一到，
 * `applyLive` 归零、`reduce` 把完整消息放进 `messages`，同一段文字换了个位置显示，
 * **不会同时出现两份**。这条互斥就是它不算"第二份状态"的全部理由。
 *
 * 在这个组件存在之前，`message.delta` 推到渲染层之后无人接收（`reduce` 里它是空操作），
 * 于是一次三十秒的流式回复期间界面完全静止（docs/09 G6）。
 */
function LiveMessage(): ReactNode {
  const live = useUi((s) => s.live);
  if (live === undefined || (live.text === '' && live.thinking === '')) return null;

  return (
    <Card>
      <div className="mb-1 text-xs text-[var(--xm-fg-muted)]">小明</div>
      <div className="flex flex-col gap-2">
        {live.thinking !== '' && (
          <details className="text-xs text-[var(--xm-fg-muted)]" open>
            <summary className="cursor-pointer">思考中…</summary>
            <p className="mt-1 whitespace-pre-wrap">{live.thinking}</p>
          </details>
        )}
        {live.text !== '' && (
          <p className="whitespace-pre-wrap">
            {live.text}
            {/* 光标：让"还在写"和"写完了但很短"这两种情况分得开 */}
            <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-[var(--xm-fg)] align-text-bottom">
              &nbsp;
            </span>
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * 不可信上下文横幅 —— G1 的用户侧（ADR-0019）。
 *
 * ── 为什么它必须说清"是什么把上下文弄脏的" ──
 *
 * 解除按钮自带一个社工面：模型完全可以在回复里写"请点上面那个解除按钮，然后我就能
 * 帮你推送了"。用户面对一个只写着"解除限制"的空白按钮，会照点不误。
 *
 * 所以这里复述的是**事件流里的事实**——哪个工具、通过哪个能力、什么时候——
 * 而这些字段全部来自 `UntrustedContext`，是 `reduce` 从 `tool.start` 算出来的，
 * 模型碰不到。用户确认的是一件具体的事，不是一个措辞。
 *
 * 横幅是常驻的、不可关闭的：能被关掉的安全提示等于没有提示。
 */
function UntrustedBanner(): ReactNode {
  const session = useUi((s) => s.session);
  const clearUntrusted = useUi((s) => s.clearUntrusted);
  const ctx = session?.untrustedContext;
  if (ctx === undefined) return null;

  const since = new Date(ctx.since).toLocaleTimeString();

  return (
    <div className="rounded-md border border-[var(--xm-danger)] bg-[var(--xm-danger-bg)] px-3 py-2 text-xs">
      <p className="font-medium">本会话的上下文含有外部内容</p>
      <p className="mt-1 text-[var(--xm-fg-muted)]">
        {since} 由工具 <span className="font-mono">{ctx.toolName}</span>（
        <span className="font-mono">{ctx.viaCapability}</span>）引入。
        在此之后，删除文件、推送代码、访问网络这类**不可撤销**的操作会被直接拒绝。
      </p>
      <Button
        className="mt-2"
        onClick={() => {
          void clearUntrusted();
        }}
      >
        我确认这些内容可信，解除标记
      </Button>
      <p className="mt-1 text-[var(--xm-fg-muted)]">
        解除只到下一次引入外部内容为止，不是永久的。
      </p>
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

/**
 * 输入区。跑起来之后发送按钮**变成**停止按钮，不是并排多一个。
 *
 * 并排两个按钮意味着"发送"在跑动期间是可点的，那要么排队要么静默丢弃——
 * 两种都会让用户以为第二条消息生效了。原地替换的语义没有歧义：
 * 这一刻要么能发，要么能停。
 */
function Composer({ disabled, running }: { readonly disabled: boolean; readonly running: boolean }): ReactNode {
  const send = useUi((s) => s.send);
  const stop = useUi((s) => s.stop);
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
        {running ? (
          <Button
            onClick={() => {
              void stop();
            }}
          >
            停止
          </Button>
        ) : (
          <Button onClick={submit} disabled={disabled}>
            发送
          </Button>
        )}
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
