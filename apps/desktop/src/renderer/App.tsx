import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppMenu } from './components/app-menu.js';
import {
  InterruptedSessionBanner,
  NoticeBanner,
  SessionConflictBanner,
  SetupBanner,
  TurnErrorBanner,
  UntrustedBanner,
} from './components/banners.js';
import { Composer } from './components/composer.js';
import { HomeView } from './components/home-view.js';
import { LiveMessage } from './components/live-views.js';
import { MessageStream } from './components/message-stream.js';
import { SessionTabs } from './components/session-tabs.js';
import { DiffReviewPanel } from './components/diff-review-panel.js';
import { SecurityView } from './components/security-view.js';
import { WorkbenchPanel } from './components/workbench-panel.js';
import { Button } from './components/ui.js';
import { PanelRightIcon } from './components/icons.js';
import { api } from './bridge.js';
import { cn } from './lib/cn.js';
import { COLUMN } from './lib/layout.js';
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
  const [workbenchOpen, setWorkbenchOpen] = useState(false);

  useEffect(() => {
    void refreshSessions();
    void refreshStatus();
    void refreshOrphanedSessions();
    return api.onEvent((event) => {
      applyEvent(event);
      /*
       * 标题只被 `applyEvent` 里的 reduce 更新到**当前会话**那一份状态上。
       * Home 列表与非焦点 tab 读的是 `listSessions()` 的摘要投影，它不过 reduce
       * （见 store.ts 顶部注释），只能重拉一次——否则"发完第一条消息立刻回 Home
       * 并停在那里"的用户会一直看着「新会话」（ADR-0038）。
       */
      if (event.type === 'session.renamed') void refreshSessions();
    });
  }, [refreshSessions, refreshStatus, refreshOrphanedSessions, applyEvent]);

  useEffect(() => {
    if (shellView === 'home') void refreshSessions();
  }, [shellView, refreshSessions]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    stickToBottom.current = true;
    setWorkbenchOpen(false);
  }, [currentId]);

  /*
   * Home 与对话共用同一个滚动容器。对话默认贴底，scrollTop 很大；若不复位，
   * 跳回 Home 时列表（最新在上）会停在底部——用户看到的是最旧会话。
   * 反过来：Home 把滚动顶到 0 后 onScroll 会把 stickToBottom 冲成 false，
   * 再点回同一会话 tab 时 currentId 不变、贴底标志也不会被上面那条重置，
   * 于是对话也贴不上底。进出 Home 时成对处理。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (shellView === 'home') {
      if (el !== null) el.scrollTop = 0;
      return;
    }
    stickToBottom.current = true;
  }, [shellView]);

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
  }, [session?.messages, live.message, shellView]);

  const inChat = shellView === 'chat' && currentId !== undefined;
  const hasWorkbenchContent = session !== undefined && (
    session.todos.length > 0 ||
    session.checkpoints.length > 0 ||
    session.runningCalls.size > 0 ||
    live.terminals.size > 0
  );

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg">
      {/*
        顶栏坐在页面底色上，不再自己顶一层 surface —— 选中的 tab 才用 surface。
        上一版两者同色，选中态在顶栏上等于看不见（见 `session-tabs.tsx`）。
        定高 44px：汉堡 / Home / tabs / 工作区开关落在同一条基线上。
      */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <AppMenu />
        <SessionTabs />
        <div className="flex shrink-0 items-center gap-2">
          {inChat && hasWorkbenchContent && (
            <Button
              size="icon"
              variant="ghost"
              className={cn(workbenchOpen && 'bg-surface-2 text-fg')}
              aria-label={workbenchOpen ? '隐藏工作区' : '显示工作区'}
              aria-expanded={workbenchOpen}
              title={workbenchOpen ? '隐藏工作区' : '显示工作区'}
              onClick={() => { setWorkbenchOpen((value) => !value); }}
            >
              <PanelRightIcon />
            </Button>
          )}
        </div>
      </header>

      {error !== undefined && (
        <div className="shrink-0 border-b border-danger-border bg-danger-bg px-6 py-2 text-meta text-danger">
          {error}
        </div>
      )}

      {/*
        `scrollbar-gutter: stable both-edges` 不是可有可无的细节：滚动条只占滚动区的宽度，
        而输入区在滚动区之外。不预留就会出现"有滚动条时消息栏比输入框往左偏 3px"——
        肉眼说不出哪里不对，但两条本该对齐的竖线一直差着一点。两边都留，居中才与输入区一致。
      */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]"
          >
            <div key={`${shellView}:${currentId ?? ''}`} className="ui-view-enter">
              {shellView === 'security' ? (
                <SecurityView />
              ) : shellView === 'home' || currentId === undefined ? (
                <HomeView />
              ) : (
                <div className={cn(COLUMN, 'flex flex-col gap-6 py-6')}>
                  <SetupBanner />
                  <SessionConflictBanner />
                  <NoticeBanner />
                  <UntrustedBanner />
                  <MessageStream messages={session?.messages ?? []} />
                  <LiveMessage />
                  {session !== undefined && (
                    <DiffReviewPanel sessionId={session.id} proposals={session.editProposals} />
                  )}
                </div>
              )}
            </div>
          </div>

          {inChat && (
            <>
              <div className={cn(COLUMN, 'flex shrink-0 flex-col gap-2 pb-2 empty:hidden')}>
                <InterruptedSessionBanner />
                <TurnErrorBanner />
              </div>
              <Composer disabled={busy} running={session?.status === 'running'} />
            </>
          )}
        </div>

        {inChat && hasWorkbenchContent && (
          <WorkbenchPanel
            sessionId={session.id}
            todos={session.todos}
            checkpoints={session.checkpoints}
            open={workbenchOpen}
          />
        )}
      </div>
    </div>
  );
}
