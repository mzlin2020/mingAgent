import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 用量与成本。
 *
 * ── 未计价的回合必须显示出来，不能并进那个数字 ──
 *
 * 仓库里不带默认价格表（`contracts/model/price.ts` 说明了为什么：带一份就等于发布一个
 * 会过期的事实）。于是"$0.00"有两种可能：真没花钱，或者我们不知道花了多少。
 * 把后者显示成前者，用户就拿到了一个自信的错数字——比诚实地说"未计价"糟糕得多。
 *
 * ── `seq` 与原始 status 字符串从顶栏撤下来 ──
 *
 * 上一版这里直接打的是 `1,234 tok · $0.0021 · seq 42 · running`。后两项是调试信息：
 * `seq` 是事件流游标，`status` 是内部枚举的英文原值——它们出现在产品 chrome 里，
 * 是"这东西还没做完"的观感来源之一。`seq` 挪进悬浮提示（排查时仍然拿得到），
 * `status` 直接去掉：tab 上的状态徽标已经在表达同一件事，而且是中文的。
 */
export function UsageBadge(): ReactNode {
  const session = useUi((s) => s.session);
  if (session === undefined) return null;

  const { usage, costUsd, unpricedTurns } = session.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost =
    unpricedTurns > 0
      ? `≥ $${costUsd.toFixed(4)}（${String(unpricedTurns)} 次未计价）`
      : costUsd > 0
        ? `$${costUsd.toFixed(4)}`
        : '';
  const parts = [tokens > 0 ? `${tokens.toLocaleString()} tok` : '', cost].filter((p) => p !== '');
  if (parts.length === 0) return null;

  return (
    <span
      className="text-micro tabular-nums text-faint"
      title={`事件序号 seq ${String(session.lastSeq)} · ${session.status}`}
    >
      {parts.join(' · ')}
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
    <div className="rounded-card border border-border bg-surface-2 px-4 py-3 text-meta">
      <p className="text-body font-medium">还没有配置模型</p>
      <p className="mt-1 text-muted">
        当前模型：<span className="font-mono">{status.providerId}</span> /{' '}
        <span className="font-mono">{status.model}</span>
        {status.hasApiKey && '（配置里有密钥引用，但取不到值）'}
      </p>

      {blocked ? (
        <p className="mt-2 text-muted">
          系统钥匙串不可用，因此**无法保存密钥**——不会退化成明文保存。
          在 Linux 上通常是缺少 gnome-keyring 或 kwallet，装好并启动后重开小明。
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="password"
            value={key}
            placeholder={`${status.providerId} 的 API key`}
            className={cn(
              'h-9 min-w-0 flex-1 rounded-control border border-border bg-surface px-3',
              'font-mono text-meta outline-none transition-colors',
              'placeholder:font-sans placeholder:text-faint focus:border-accent',
            )}
            onChange={(e) => {
              setKey(e.target.value);
            }}
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
 *
 * **挂载位置是这条横幅的一半**：它必须在滚动区之外、输入框正上方。放进消息流顶部
 * 等于钉在一个 stick-to-bottom 容器的最上方，会话一超过一屏就再也看不见——
 * 那正是上面说的缺口的第二形态。理由写在 `App.tsx` 的挂载点上。
 */
export function TurnErrorBanner(): ReactNode {
  const session = useUi((s) => s.session);
  const error = session?.lastError;
  if (error === undefined) return null;

  return (
    <div className="rounded-card border border-danger-border bg-danger-bg px-4 py-3 text-meta">
      <p className="font-medium text-danger">上一轮出错了</p>
      <p className="mt-1">{error.message}</p>
      {error.retryable && <p className="mt-1 text-muted">这类错误通常可以直接重试。</p>}
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
    <div className="rounded-card border border-border bg-surface-2 px-4 py-3 text-meta">
      {notices.map((n, i) => (
        <p key={i} className={n.level === 'warn' ? '' : 'text-muted'}>
          {n.message}
        </p>
      ))}
    </div>
  );
}

/**
 * 本会话读过外部内容（网页 / 终端回显 / 截屏），因此进入了不可信上下文（ADR-0019）。
 *
 * ── 为什么这个横幅必须存在（ADR-0039 之后它是唯一的人类介入点）──
 *
 * 不可信上下文会拦掉三类"后果留在本会话之外"的操作（推远端 / 装依赖 / 改系统设置，
 * 见 `kernel/policy/defaults.ts` 的 `UNTRUSTED_CONTEXT_RULES`）与三条红线
 * （读密钥 / 操作 GUI / 装插件）。审批卡片删掉之后，被拦的用户在应用里只剩两条出路：
 * 手改 `config.json`，或者点这个按钮。**没有这个按钮，"被拦"就等于"卡住"。**
 *
 * `clearUntrusted` 这条 IPC 从 ADR-0019 起就是通的，但渲染层一直没有入口——
 * 本项目"规则存在 ≠ 规则生效"的另一种形状：出路存在，用户按不到。
 *
 * ── 文案必须如实说出解除会放开什么 ──
 *
 * 解除放倒的是**整轮**防线，不是"只允许这一个目标"（后者需要一次事中授权，
 * 而那正是被删掉的东西）。让用户以为自己只开了一条缝，比不给他这个按钮更糟。
 */
export function UntrustedBanner(): ReactNode {
  const session = useUi((s) => s.session);
  const clearUntrusted = useUi((s) => s.clearUntrusted);
  const ctx = session?.untrustedContext;
  if (ctx === undefined) return null;

  return (
    <div className="rounded-card border border-border bg-surface-2 px-4 py-3 text-meta">
      <p className="font-medium">这个会话读过外部内容</p>
      <p className="mt-1 text-muted">
        来自工具 <span className="font-mono text-micro">{ctx.toolName}</span>（
        {ctx.viaCapability}）。外部内容可能包含指使小明做别的事的文字，所以在解除之前，
        <b>推送到远端、安装依赖、修改系统设置</b>会被拒绝，读取密钥、操作鼠标键盘、
        安装插件是红线（解除也不放开）。其余操作照常。
      </p>
      <p className="mt-1 text-muted">
        解除会放开上面那三类——<b>范围是整个会话，不是某一个目标</b>。确认这些外部内容
        没有问题再点。
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-3"
        onClick={() => {
          void clearUntrusted();
        }}
      >
        我看过了，解除标记
      </Button>
    </div>
  );
}

export const ORPHAN_KIND_LABEL: Record<'message' | 'tool' | 'none', string> = {
  message: '模型正在生成回复',
  tool: '有工具调用没跑完',
  none: '停在了一次往返之间',
};

/**
 * 崩溃恢复（M1-e，docs/04 §8）。**会话内横幅**——只在当前打开的会话恰好是一个
 * 被中断的会话时渲染，和 `TurnErrorBanner` 并列。
 *
 * ── 为什么从"跨会话全局横幅"降格成这样（M1-e 会话列表状态整合） ──
 *
 * 老版本（`CrashRecoveryBanner`）是跨会话的：用户很可能根本没打开过那个被中断的
 * 会话，若横幅只在"恰好点进那个会话"时才出现，就退回了 docs/04 §8 明确要防的
 * "任务消失了但没人知道"。这个诉求现在由会话列表/顶栏 tabs 的状态徽标 +
 * 状态优先排序覆盖——被中断的会话在 Home「最近会话」与 tabs 上可见并带标记，
 * 不需要打开就能看到，比一段汇总在顶部、找不到具体是哪个会话的文案更有用。
 * 腾出来的这个位置换成"贴着当前会话上下文"的展示：用户能同时看到卡在哪、
 * 卡成什么样，跟 `TurnErrorBanner` 一样的姿态。
 *
 * 继续/放弃两个动作与文案原样保留，只是渲染条件从"遍历全部 `orphanedSessions`"
 * 收窄成"只取 `currentId` 对应的一条"。
 */
export function InterruptedSessionBanner(): ReactNode {
  const currentId = useUi((s) => s.currentId);
  const orphanedSessions = useUi((s) => s.orphanedSessions);
  const resumeOrphaned = useUi((s) => s.resumeOrphaned);
  const abandonOrphaned = useUi((s) => s.abandonOrphaned);
  const [busy, setBusy] = useState(false);

  const orphan = orphanedSessions.find((o) => o.sessionId === currentId);
  if (orphan === undefined) return null;

  return (
    <div className="rounded-card border border-danger-border bg-danger-bg px-4 py-3 text-meta">
      <p className="font-medium text-danger">这个会话在你不在时被中断了</p>
      <p className="mt-1 text-muted">
        {ORPHAN_KIND_LABEL[orphan.kind]}——它不会自己消失，选一个处理方式：
      </p>
      {/* "继续"是这里想让用户走的那条路；上一版两个按钮都是实心橙色，看不出主次 */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void resumeOrphaned(orphan.sessionId).finally(() => {
              setBusy(false);
            });
          }}
        >
          继续
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void abandonOrphaned(orphan.sessionId).finally(() => {
              setBusy(false);
            });
          }}
        >
          放弃
        </Button>
      </div>
    </div>
  );
}

/**
 * 会话冲突（M1-e 错误态呈现）：这个会话正被另一个写句柄占用（`WriteLeaseError`）。
 *
 * 与顶层的通用 `error` 横幅不同——那条是"未分类错误的最后防线"，这条是专门给
 * 这一种、用户能采取具体行动的错误准备的文案：告诉他"是什么"而不是甩一句
 * 原始异常消息。见 `ipc-error.ts` 的 `classifyIpcError`。
 *
 * 不做自动重试：另一个窗口/进程什么时候放手是不可预测的，硬轮询只会把这条
 * 横幅变成一个不停闪烁的东西。用户自己决定什么时候点"重新打开"。
 */
export function SessionConflictBanner(): ReactNode {
  const conflict = useUi((s) => s.sessionConflict);
  const openSession = useUi((s) => s.openSession);
  if (conflict === undefined) return null;

  return (
    <div className="rounded-card border border-danger-border bg-danger-bg px-4 py-3 text-meta">
      <p className="font-medium text-danger">这个会话正被另一个窗口占用</p>
      <p className="mt-1 text-muted">
        通常是另一个小明窗口或进程正开着同一个会话。关掉那一边之后再重新打开这个会话。
      </p>
      <p className="mt-1 font-mono text-micro text-faint">{conflict.message}</p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-3"
        onClick={() => {
          void openSession(conflict.sessionId);
        }}
      >
        重新打开
      </Button>
    </div>
  );
}
