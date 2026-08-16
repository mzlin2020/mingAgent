import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AppMenu } from './components/app-menu.js';
import { Conversation } from './components/conversation.js';
import { HomeView } from './components/home-view.js';
import { SessionTabs } from './components/session-tabs.js';
import { installBuiltinRenderers } from './components/cards.js';
import { SettingsModal } from './components/settings-modal.js';
import { WorkbenchPanel } from './components/workbench-panel.js';
import { Button } from './components/ui.js';
import { PanelRightIcon } from './components/icons.js';
import { api } from './bridge.js';
import { cn } from './lib/cn.js';
import {
  countNativeToolCalls,
  shouldOpenDetailsOnSelect,
  shouldShowDetailsColumn,
} from './lib/call-material.js';
import { useDetailsColumn } from './lib/use-details-column.js';
import { useScrollPin } from './lib/use-scroll-pin.js';
import { useUi } from './store.js';

/**
 * 壳层（ADR-0037）：顶栏（汉堡 / Home / tabs）+ Home 或对话主视图。
 * 新建入口在 Home；无常驻侧栏。消息仍全部来自 `reduce(events)`（ADR-0015）。
 *
 * ── 这个文件只做装配（ADR-0032）──
 */
/*
 * 四种内建卡片渲染器在模块装载时注册一次（ADR-0058 §五）。
 * 放在这里而不是某个组件的 effect 里：注册表是进程级的，
 * 挂载/卸载一个组件不该让别处的卡片突然退化成摘要。
 */
installBuiltinRenderers();

export function App(): ReactNode {
  const { currentId, session, error, shellView, settingsOpen } = useUi();
  const live = useUi((s) => s.live);
  const refreshSessions = useUi((s) => s.refreshSessions);
  const refreshStatus = useUi((s) => s.refreshStatus);
  const refreshOrphanedSessions = useUi((s) => s.refreshOrphanedSessions);
  const applyEvent = useUi((s) => s.applyEvent);
  const details = useDetailsColumn();
  const selectedCallId = useUi((s) => s.selectedCallId);
  const dispatches = useUi((s) => s.dispatches);
  const prevSelected = useRef(selectedCallId);

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

  const inChat = shellView === 'chat' && currentId !== undefined;
  const scroll = useScrollPin({
    resetKey: `${shellView}:${currentId ?? ''}`,
    mode: inChat ? 'pin' : 'top',
    contentKey: inChat
      ? `${String(session?.messages.length ?? 0)}:${live.message?.text ?? ''}:${live.message?.thinking ?? ''}`
      : 'home',
  });

  useEffect(() => {
    if (shouldOpenDetailsOnSelect(prevSelected.current, selectedCallId, details.openPref)) {
      details.toggleOpen();
    }
    prevSelected.current = selectedCallId;
  }, [selectedCallId, details.openPref, details.toggleOpen]);

  const hasWorkspaceBlocks = session !== undefined && (
    session.todos.length > 0 ||
    session.checkpoints.length > 0 ||
    session.runningCalls.size > 0 ||
    live.terminals.size > 0
  );
  const showPanel = inChat && session !== undefined && shouldShowDetailsColumn({
    hasWorkspaceBlocks,
    selected: selectedCallId !== undefined,
    nativeCalls: countNativeToolCalls(session.messages),
    dispatchCount: dispatches.size,
  });

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg">
      {/*
        顶栏坐在页面底色上。选中 tab 用底部 2px 指示条（ADR-0074），不再靠填充区分。
        定高 44px：汉堡 / Home / tabs / 右栏开关落在同一条基线上。
      */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <AppMenu />
        <SessionTabs />
        <div className="flex shrink-0 items-center gap-2">
          {inChat && showPanel && (
            <Button
              size="icon"
              variant="ghost"
              className={cn(details.openPref && 'bg-accent-weak text-fg')}
              aria-label={details.openPref ? '隐藏右栏' : '显示右栏'}
              aria-expanded={details.openPref}
              title={details.openPref ? '隐藏右栏' : '显示右栏'}
              onClick={details.toggleOpen}
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
        输入区进了滚动容器（sticky bottom），竖线天然同轴，不再需要 both-edges。
        单侧 stable 仍要：sticky 贴的是 content box，滚动条出没会让整列横移。
      */}
      <div ref={details.frameRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            ref={scroll.ref}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
          >
            <div
              key={`${shellView}:${currentId ?? ''}`}
              className="ui-view-enter flex min-h-full flex-col"
            >
              {shellView === 'home' || currentId === undefined ? (
                <HomeView />
              ) : (
                <Conversation
                  showToBottom={!scroll.pinned}
                  onToBottom={scroll.scrollToBottom}
                />
              )}
            </div>
          </div>
        </div>

        {inChat && showPanel && (
          <WorkbenchPanel
            sessionId={session.id}
            todos={session.todos}
            checkpoints={session.checkpoints}
            width={details.width}
            innerWidth={details.collapsed ? details.prefWidth : details.width}
            collapsed={details.collapsed}
            resizing={details.resizing}
            onResizeStart={details.beginResize}
          />
        )}
      </div>
      {settingsOpen && <SettingsModal />}
    </div>
  );
}
