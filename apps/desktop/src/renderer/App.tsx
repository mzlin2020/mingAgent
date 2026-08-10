import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AppMenu } from './components/app-menu.js';
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
import { HomeView } from './components/home-view.js';
import { LiveCalls, LiveMessage } from './components/live-views.js';
import { MessageStream } from './components/message-stream.js';
import { PermissionCard } from './components/permission-card.js';
import { SessionTabs } from './components/session-tabs.js';
import { TerminalPanel } from './components/terminal-panel.js';
import { api } from './bridge.js';
import { useUi } from './store.js';

/**
 * 壳层（ADR-0037）：顶栏（汉堡 / Home / tabs）+ Home 或对话主视图。
 * 新建入口在 Home；无常驻侧栏。消息仍全部来自 `reduce(events)`（ADR-0015）。
 *
 * ── 这个文件只做装配（ADR-0032）──
 */
export function App(): ReactNode {
  const { currentId, session, busy, error, shellView } = useUi();
  const live = useUi((s) => s.live);
  const refreshSessions = useUi((s) => s.refreshSessions);
  const refreshStatus = useUi((s) => s.refreshStatus);
  const refreshOrphanedSessions = useUi((s) => s.refreshOrphanedSessions);
  const applyEvent = useUi((s) => s.applyEvent);

  useEffect(() => {
    void refreshSessions();
    void refreshStatus();
    void refreshOrphanedSessions();
    return api.onEvent(applyEvent);
  }, [refreshSessions, refreshStatus, refreshOrphanedSessions, applyEvent]);

  useEffect(() => {
    if (shellView === 'home') void refreshSessions();
  }, [shellView, refreshSessions]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    stickToBottom.current = true;
  }, [currentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [currentId, shellView]);

  useEffect(() => {
    if (shellView !== 'chat') return;
    const el = scrollRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [session?.messages, live, shellView]);

  const inChat = shellView === 'chat' && currentId !== undefined;

  return (
    <div className="flex h-screen flex-col bg-[var(--xm-bg)] text-[var(--xm-fg)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--xm-border)] bg-[var(--xm-surface)] px-2 py-1.5">
        <AppMenu />
        <SessionTabs />
        <div className="flex shrink-0 items-center gap-2 pr-1">
          {inChat && (
            <>
              <ApprovalModeSwitcher />
              <UsageBadge />
            </>
          )}
        </div>
      </header>

      {error !== undefined && (
        <div className="shrink-0 border-b border-[var(--xm-border)] bg-[var(--xm-danger-bg)] px-4 py-2 text-xs">
          {error}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {shellView === 'home' || currentId === undefined ? (
          <HomeView />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
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

      {inChat && (
        <>
          <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-2 empty:hidden">
            <InterruptedSessionBanner />
            <TurnErrorBanner />
          </div>
          <Composer
            disabled={busy}
            running={session?.status === 'running' || session?.status === 'waiting_permission'}
          />
        </>
      )}
    </div>
  );
}
