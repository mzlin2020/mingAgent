import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ApprovalModeSwitcher } from './components/approval-mode-switcher.js';
import {
  InterruptedSessionBanner,
  NoticeBanner,
  SessionConflictBanner,
  SetupBanner,
  TurnErrorBanner,
  UsageBadge,
} from './components/banners.js';
import { Composer } from './components/composer.js';
import { LiveCalls, LiveMessage } from './components/live-views.js';
import { MessageStream } from './components/message-stream.js';
import { PermissionCard } from './components/permission-card.js';
import { SessionList } from './components/session-list.js';
import { TerminalPanel } from './components/terminal-panel.js';
import { api } from './bridge.js';
import { useUi } from './store.js';

/**
 * 最小三栏：会话列表 / 消息流 / 输入框。
 *
 * 消息全部来自 `useUi().session`，而那是 `reduce(events)` 的结果——
 * UI 里没有第二份 messages 数组。这条约束在这里看着像多余的严格，
 * 但它是"刷新一下内容就变了"这类问题唯一的根治办法（ADR-0015）。
 *
 * ── 这个文件只做装配（ADR-0032，修规模纪律）──
 *
 * 每个观察面板/横幅/输入区都是 `./components/*` 下的独立文件，`App.tsx` 本身
 * 只负责拼起来。它曾经是一个 1023 行的单文件，每加一个面板类型（`TerminalPanel`/
 * `ApprovalModeSwitcher` 都是这么进来的）就往里面追加一段——这正是
 * docs/05 §1 开篇那句"这一层设计错了，后面所有能力都会被迫走后门"预言的形状。
 * 拆开之后新增一种面板只需要在 `components/` 下加一个文件，不用再碰这个文件的
 * 其余部分（通用观察面板/渲染器注册表仍未实现，见 docs/05 §6，这里只是
 * 提前把"焊死在一起"这一半问题拆掉）。
 */
export function App(): ReactNode {
  const { currentId, session, busy, error } = useUi();
  const live = useUi((s) => s.live);
  const refreshSessions = useUi((s) => s.refreshSessions);
  const refreshStatus = useUi((s) => s.refreshStatus);
  const refreshOrphanedSessions = useUi((s) => s.refreshOrphanedSessions);
  const applyEvent = useUi((s) => s.applyEvent);

  useEffect(() => {
    void refreshSessions();
    void refreshStatus();
    void refreshOrphanedSessions();
    // 订阅主进程推来的事件。总线在主进程，这里只是消费端（ADR-0013 不变量五）
    return api.onEvent(applyEvent);
  }, [refreshSessions, refreshStatus, refreshOrphanedSessions, applyEvent]);

  /*
   * 自动跟随滚动。
   *
   * 消息流容器原来只有 `overflow-y-auto`，内容变长时滚动条位置不动——
   * 模型流式吐字、工具跑进度的时候，新内容全部长在可视区域之外，用户得自己
   * 一直往下拽。真正的停止条件不是"内容变了就无脑滚到底"（那样用户往上翻看
   * 历史消息时会被每一条 delta 强行拽回底部，等于滚动条根本没法用来看历史），
   * 而是"用户本来就跟着看，才继续帮他跟着看"——用 `stickToBottom` 记录用户
   * 上一次滚动后离底部还有多远，只有在他本来就贴着底部时才自动跟。
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    // 切会话：不管上一个会话滚到哪里去了，新会话一律先贴底
    stickToBottom.current = true;
  }, [currentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      // 离底部 64px 以内算"还在跟着看"，用户主动往上翻了就不再帮他拽回去
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [currentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
    // `live` 覆盖了正文/思考的流式增量与工具进度——那两类内容不落进
    // `session.messages`（ADR-0021），只看 messages 会漏掉整个流式过程。
    // 待审批卡片不走这里：它由 `PermissionCard` 在 requestId 出现时自行
    // scrollIntoView（阻塞交互，不能被 stickToBottom 挡住）。
  }, [session?.messages, live]);

  return (
    <div className="flex h-screen bg-[var(--xm-bg)] text-[var(--xm-fg)]">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--xm-border)] px-4 py-2">
          <span className="truncate text-sm font-medium">
            {session?.title === '' || session === undefined ? '小明' : session.title}
          </span>
          <div className="flex items-center gap-3">
            {currentId !== undefined && <ApprovalModeSwitcher />}
            <UsageBadge />
          </div>
        </header>

        {error !== undefined && (
          <div className="border-b border-[var(--xm-border)] bg-[var(--xm-danger-bg)] px-4 py-2 text-xs">
            {error}
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {currentId === undefined ? (
            <p className="mt-16 text-center text-sm text-[var(--xm-fg-muted)]">左侧新建一个会话开始。</p>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {/*
                留在这里的都是**会话级的常驻状态**：没配模型、密钥后端降级等。
                它们描述的是"这个会话现在是什么样"，不绑定某一个时刻，
                用户回看历史时在顶部看到它们是合理的。

                "刚刚出事了、要你现在处理"的那两条不在这里——见下面滚动区外那一块。
              */}
              <SetupBanner />
              <SessionConflictBanner />
              <NoticeBanner />
              <MessageStream messages={session?.messages ?? []} />
              <LiveMessage />
              <LiveCalls />
              <TerminalPanel />
              <PermissionCard />
            </div>
          )}
        </div>

        {/*
          ── 出错与中断横幅**必须在滚动区外** ──

          它们本来和上面那几条并排放在滚动容器里、`MessageStream` 之前。那等于把它们钉死在
          整条消息流的最上方，而这个滚动区是 stick-to-bottom 的（见上面的 effect）：
          只要会话超过一屏，横幅就必然在视口外。一次真实体验里正是这样——Provider 返回
          400，`lastError` 算对了、也渲染了，用户却完全看不见，只感觉"发了消息没反应"。

          `banners.tsx` 的注释里已经记着这个缺口的第一形态（算出来了但没人渲染）。
          这是第二形态：渲染了，但渲染在看不见的地方。所以修法不是换个颜色或加个角标，
          是把它挪出滚动区——放在输入框正上方，用户视线本来就在的地方。

          还有一层：`lastError` 会在下一轮 `turn.start` 时清掉（reduce.ts）。用户出错后
          随手再发一条，横幅会先消失再重新出现；如果它在视口外，这个过程零反馈。
        */}
        {/* `empty:hidden`：两条横幅都不渲染时这层整个消失，不留一条空白缝 */}
        <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-2 empty:hidden">
          <InterruptedSessionBanner />
          <TurnErrorBanner />
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
