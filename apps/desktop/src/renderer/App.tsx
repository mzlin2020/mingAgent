import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ContentBlock, Message } from '@xm/contracts';
import { api } from './bridge.js';
import { MarkdownText } from './components/markdown.js';
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
              <TurnErrorBanner />
              <NoticeBanner />
              <UntrustedBanner />
              <MessageStream messages={session?.messages ?? []} />
              <LiveMessage />
              <LiveCalls />
              <PermissionCard />
            </div>
          )}
        </div>

        {/*
          `busy` 是"这次 IPC 还没返回"，`session.status === 'running'` 是"事件流说它在跑"。
          停止按钮认后者：前者在网络往返期间也为真，而那时还没有任何东西可停。

          `waiting_permission` 也算——那仍然是同一个未完成的 turn，只是卡在等审批，
          `services.ts` 的 `interrupt()` 本来就认这个状态（denyAllPending 先兑现挂起的
          审批，再 abort）。之前只认 `running` 会让用户在权限卡片弹出的那段时间
          彻底没有退出的入口，只能等（或者去点一张早就对不上 requestId 的卡片）。
        */}
        <Composer
          disabled={currentId === undefined || busy}
          running={session?.status === 'running' || session?.status === 'waiting_permission'}
        />
      </main>
    </div>
  );
}

/**
 * 消息流。工具结果先索引一遍，再交给每条消息——`tool_use` 与 `tool_result`
 * 分处两条消息，不索引就配不成一张卡（见 `indexResults`）。
 */
function MessageStream({ messages }: { readonly messages: readonly Message[] }): ReactNode {
  const results = indexResults(messages);
  return (
    <>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} results={results} />
      ))}
    </>
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
 * 上一轮真正失败时的错误——读的是 `session.lastError`（`error.raised` 事件落下的），
 * 不是顶部那条 `error`（那个只捕获 IPC 调用本身的失败，`store.ts` 里的 try/catch）。
 *
 * 两者是完全不同的东西：Provider 返回 400 时，"发消息"这个 IPC 调用照常成功返回——
 * 失败发生在 Turn 内部的流式读取里，顶部的 `error` 永远不会被置上。这曾经是一个
 * 真实的用户体验缺口：`lastError` 从一开始就在 `reduce()` 里被正确地算出来，
 * 却没有任何渲染代码读过它——用户看到的只是"发了消息但没反应"，
 * 真正的原因（比如 DeepSeek 拒绝了带点号的工具名）只在 events.db 里躺着。
 *
 * `lastError` 在下一轮 `turn.start` 时会被清掉（reduce.ts），所以这里不需要
 * 自己的关闭按钮——新一轮的用户输入本身就是"要重试"的信号。
 */
function TurnErrorBanner(): ReactNode {
  const session = useUi((s) => s.session);
  const error = session?.lastError;
  if (error === undefined) return null;

  return (
    <div className="rounded-md border border-[var(--xm-danger)] bg-[var(--xm-danger-bg)] px-3 py-2 text-xs">
      <p className="font-medium">上一轮出错了</p>
      <p className="mt-1">{error.message}</p>
      {error.retryable && (
        <p className="mt-1 text-[var(--xm-fg-muted)]">这类错误通常可以直接重试。</p>
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
  const message = useUi((s) => s.live.message);
  if (message === undefined || (message.text === '' && message.thinking === '')) return null;

  return (
    <Card>
      <div className="mb-1 text-xs text-[var(--xm-fg-muted)]">小明</div>
      <div className="flex flex-col gap-2">
        {message.thinking !== '' && (
          <details className="text-xs text-[var(--xm-fg-muted)]" open>
            <summary className="cursor-pointer">思考中…</summary>
            <p className="mt-1 whitespace-pre-wrap">{message.thinking}</p>
          </details>
        )}
        {message.text !== '' && (
          <p className="whitespace-pre-wrap">
            {/*
              在途文字**不过 Markdown**：半截的语法（一个还没闭合的 ``` 或 |）
              会让渲染结果在打字过程中反复跳变。落库之后的那一份才渲染。
            */}
            {message.text}
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
 * 正在跑的工具及其最新进度（ADR-0021 的第二半）。
 *
 * `tool.progress` 与 `message.delta` 一样是瞬态事件，在 `reduce` 里同样是空操作——
 * 所以在这个组件存在之前，一次读几千个文件的调用期间界面上什么也不会变。
 *
 * 它读的是 `live.calls`，归零由 `tool.end` 负责。与在途文字不同的是：
 * 这里显示的内容**永远不会**出现在 `session.messages` 里（那里放的是工具的结果），
 * 所以它不是"先在 buffer 后在 state"，而是"用完就没了"。
 */
function LiveCalls(): ReactNode {
  const calls = useUi((s) => s.live.calls);
  const running = useUi((s) => s.session?.runningCalls);
  if (running === undefined || running.size === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {[...running.values()].map((c) => (
        <div
          key={c.callId}
          className="rounded-md border border-[var(--xm-border)] px-3 py-2 text-xs"
        >
          <span className="font-mono font-medium">{c.name}</span>
          <span className="ml-2 text-[var(--xm-fg-muted)]">
            {calls.get(c.callId)?.message ?? '运行中…'}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 审批卡片 —— 权限闸门的用户侧。
 *
 * ── 为什么内联在消息流里，不是模态框 ──
 *
 * 模态框挡住上下文，而用户恰恰要看着上下文才能判断这次操作合不合理
 * （"它刚才说要改哪个文件来着？"）。挡住之后剩下的只有"允许/拒绝"两个按钮，
 * 那时唯一理性的选择就是点允许。
 *
 * ── 卡片上的每一个字都来自事件流 ──
 *
 * 工具名、能力、**网关解析后的** target、风险等级、命中的规则 id——全部由
 * `reduce` 从 `permission.request` 算出，模型碰不到。这与 ADR-0019 的解除按钮
 * 是同一条理由：模型完全可以在回复里写"下面那个框点允许就行"，
 * 而用户要确认的必须是一件具体的事，不是一段措辞。
 *
 * ── 「永久」为什么单独一行、样式更重 ──
 *
 * 它会写进用户级配置文件并在重启后继续生效，是这四个按钮里唯一有持久后果的那个。
 * 四个等宽按钮并排会让它和"本次允许"看起来一样轻。
 */
function PermissionCard(): ReactNode {
  const request = useUi((s) => s.session?.pendingPermission);
  const respond = useUi((s) => s.respondPermission);
  if (request === undefined) return null;

  const answer = (effect: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => () => {
    void respond(request.requestId, effect, scope);
  };

  return (
    <Card className="border-[var(--xm-accent)]">
      <p className="font-medium">需要你的确认</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--xm-fg-muted)]">操作</dt>
        <dd className="font-mono">{request.capability}</dd>
        {/*
          一次调用可能过好几道闸门（ADR-0026：一条 `rm foo` 同时主张"执行命令"
          与"删除某个文件"），卡片一次显示一道，逐个应答。目标这一栏的名字随之而变——
          命令类能力下它是一条命令，路径类下它是一个文件。
        */}
        <dt className="text-[var(--xm-fg-muted)]">{request.capability.startsWith('shell.') ? '命令' : '目标'}</dt>
        <dd className="break-all font-mono">{request.target === '' ? '（无）' : request.target}</dd>
        <dt className="text-[var(--xm-fg-muted)]">风险</dt>
        <dd>{request.risk}</dd>
        <dt className="text-[var(--xm-fg-muted)]">原因</dt>
        <dd>{request.reason}</dd>
      </dl>

      {request.trustLevel === 'untrusted' && (
        <p className="mt-2 rounded bg-[var(--xm-danger-bg)] px-2 py-1 text-xs">
          本会话读过外部内容。请特别确认这次操作确实是你要的。
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={answer('allow', 'once')}>允许本次</Button>
        <Button variant="ghost" onClick={answer('allow', 'session')}>
          本会话都允许
        </Button>
        <Button variant="ghost" onClick={answer('deny', 'once')}>
          拒绝
        </Button>
        <Button variant="ghost" onClick={answer('deny', 'session')}>
          本会话都拒绝
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2 border-t border-[var(--xm-border)] pt-2">
        <Button variant="ghost" onClick={answer('allow', 'always')}>
          永久允许这个目标
        </Button>
        <span className="text-xs text-[var(--xm-fg-muted)]">
          会写进用户配置，重启后仍然生效。只针对上面那一个目标。
        </span>
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
  const chooseWorkspace = useUi((s) => s.chooseWorkspace);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--xm-border)] bg-[var(--xm-surface-2)]">
      <div className="flex flex-col gap-1 p-2">
        <Button className="w-full" onClick={() => void newSession()}>
          新会话
        </Button>
        {/*
          选目录再建会话 —— 主 DoD 任务（"读这个目录…"）的前提。
          会话的 cwd 决定模型给的相对路径落在哪，而它记在 `session.created` 里、
          此后不可改：换目录就是换一个会话，而不是让同一条事件流中途改变含义。
        */}
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => {
            void chooseWorkspace().then((cwd) => (cwd === undefined ? undefined : newSession(cwd)));
          }}
        >
          选择目录，新建会话
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

/**
 * 一次工具调用的结果，按 `toolUseId` 索引。
 *
 * 契约上 `tool_use` 与 `tool_result` 落在**两条不同的消息**里（前者在 assistant 的
 * message.end，后者由 tool.end 追加）。照事件流的顺序平铺出来，用户看到的是
 * "一个请求" + 隔了几行的"一段输出"，中间还可能夹着别的调用——一次并行调用之后
 * 就完全对不上号了。所以这里先把结果索引起来，再合并成一张卡。
 */
type ResultIndex = ReadonlyMap<string, Extract<ContentBlock, { type: 'tool_result' }>>;

function indexResults(messages: readonly Message[]): ResultIndex {
  const out = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'tool_result') out.set(b.toolUseId, b);
    }
  }
  return out;
}

function MessageView({
  message,
  results,
}: {
  readonly message: Message;
  readonly results: ResultIndex;
}): ReactNode {
  // 只含 tool_result 的消息不单独成卡：它的内容已经并进了发起它的那张工具卡
  const visible = message.blocks.filter((b) => b.type !== 'tool_result');
  if (visible.length === 0) return null;

  return (
    <Card className={message.role === 'user' ? 'bg-[var(--xm-surface-2)]' : ''}>
      <div className="mb-1 text-xs text-[var(--xm-fg-muted)]">
        {message.role === 'user' ? '你' : '小明'}
      </div>
      <div className="flex flex-col gap-2">
        {visible.map((b, i) => (
          <BlockView key={i} block={b} results={results} />
        ))}
      </div>
    </Card>
  );
}

function BlockView({
  block,
  results,
}: {
  readonly block: ContentBlock;
  readonly results: ResultIndex;
}): ReactNode {
  switch (block.type) {
    case 'text':
      return <MarkdownText text={block.text} />;

    case 'thinking':
      return (
        <details className="text-xs text-[var(--xm-fg-muted)]">
          <summary className="cursor-pointer">思考过程</summary>
          <p className="mt-1 whitespace-pre-wrap">{block.text}</p>
        </details>
      );

    case 'tool_use':
      return <ToolCard name={block.name} input={block.input} result={results.get(block.id)} />;

    case 'tool_result':
      // 正常路径下走不到这里（上面已经并进工具卡）。留着是兜底：
      // 一个找不到发起者的结果**照样要显示**，不能因为配不上对就从界面上消失
      return (
        <div className="rounded border border-[var(--xm-border)] px-2 py-1 text-xs">
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

/**
 * 工具调用卡片：请求与结果合成一张。
 *
 * 结果默认折叠。理由不是省地方，是**结果是给模型看的**——它经常是几百行文件内容，
 * 铺开来会把对话本身淹掉。用户想看的时候点开，而"它到底做了什么"（工具名 + 入参）
 * 始终可见。
 */
function ToolCard({
  name,
  input,
  result,
}: {
  readonly name: string;
  readonly input: unknown;
  readonly result: Extract<ContentBlock, { type: 'tool_result' }> | undefined;
}): ReactNode {
  const failed = result?.isError === true;
  const text = (result?.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n');

  return (
    <div
      className={cn(
        'rounded border text-xs',
        failed ? 'border-[var(--xm-danger)]' : 'border-[var(--xm-border)]',
      )}
    >
      <div
        className={cn(
          'flex items-baseline gap-2 px-2 py-1',
          failed && 'bg-[var(--xm-danger-bg)]',
        )}
      >
        <span className="font-mono font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--xm-fg-muted)]">
          {summarize(input)}
        </span>
        <span className="shrink-0 text-[var(--xm-fg-muted)]">
          {result === undefined ? '进行中' : failed ? '失败' : '完成'}
        </span>
      </div>
      {text !== '' && (
        <details className="border-t border-[var(--xm-border)]">
          <summary className="cursor-pointer px-2 py-1 text-[var(--xm-fg-muted)]">
            {failed ? '查看错误' : `查看结果（${String(text.split('\n').length)} 行）`}
          </summary>
          <pre className="max-h-96 overflow-auto px-2 pb-2 whitespace-pre-wrap">{text}</pre>
        </details>
      )}
    </div>
  );
}

/** 工具入参的一行摘要。路径类的最有用，其余退回紧凑 JSON */
function summarize(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  const record = input as Record<string, unknown>;
  const path = record.path;
  if (typeof path === 'string') return path;
  return JSON.stringify(input);
}
