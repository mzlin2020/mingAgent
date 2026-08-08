import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { useUi } from '../store.js';

/**
 * 用量与成本。
 *
 * ── 未计价的回合必须显示出来，不能并进那个数字 ──
 *
 * 仓库里不带默认价格表（`contracts/model/price.ts` 说明了为什么：带一份就等于发布一个
 * 会过期的事实）。于是"$0.00"有两种可能：真没花钱，或者我们不知道花了多少。
 * 把后者显示成前者，用户就拿到了一个自信的错数字——比诚实地说"未计价"糟糕得多。
 */
export function UsageBadge(): ReactNode {
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
export function SetupBanner(): ReactNode {
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
export function TurnErrorBanner(): ReactNode {
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
export function NoticeBanner(): ReactNode {
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
export function UntrustedBanner(): ReactNode {
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
