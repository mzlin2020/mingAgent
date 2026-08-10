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

export const ORPHAN_KIND_LABEL: Record<'message' | 'tool' | 'permission' | 'none', string> = {
  message: '模型正在生成回复',
  tool: '有工具调用没跑完',
  permission: '正等着你批一个权限',
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
    <div className="rounded-md border border-[var(--xm-danger)] bg-[var(--xm-danger-bg)] px-3 py-2 text-xs">
      <p className="font-medium">这个会话在你不在时被中断了</p>
      <p className="mt-1 text-[var(--xm-fg-muted)]">{ORPHAN_KIND_LABEL[orphan.kind]}——它不会自己消失，选一个处理方式：</p>
      <div className="mt-2 flex items-center gap-2">
        <Button
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
    <div className="rounded-md border border-[var(--xm-danger)] bg-[var(--xm-danger-bg)] px-3 py-2 text-xs">
      <p className="font-medium">这个会话正被另一个窗口占用</p>
      <p className="mt-1 text-[var(--xm-fg-muted)]">
        通常是另一个小明窗口或进程正开着同一个会话。关掉那一边之后再重新打开这个会话。
      </p>
      <p className="mt-1 font-mono text-[var(--xm-fg-muted)]">{conflict.message}</p>
      <Button
        className="mt-2"
        onClick={() => {
          void openSession(conflict.sessionId);
        }}
      >
        重新打开
      </Button>
    </div>
  );
}
