import type { ReactNode } from 'react';
import {
  ExtRecordsBanner,
  InterruptedSessionBanner,
  NoticeBanner,
  SessionConflictBanner,
  SetupBanner,
  TurnErrorBanner,
  UntrustedBanner,
} from './banners.js';
import { Composer } from './composer.js';
import { LiveMessage } from './live-views.js';
import { MessageStream } from './message-stream.js';
import { StatsLine, TurnStatus } from './turn-status.js';
import { cn } from '../lib/cn.js';
import { CHAT_AXIS, CHAT_BODY, isConversationHero, workspaceLabel } from '../lib/layout.js';
import { useUi } from '../store.js';

/**
 * 对话列：hero → docked 是同一个输入卡的位移，不是两个视图。
 *
 * Home 是「最近会话」入口，hero 是「这个会话还没开始」。两者在本段拆开——
 * 空会话不再落到 HomeView 上。不做背景光晕。
 */

export function Conversation({
  showToBottom,
  onToBottom,
}: {
  readonly showToBottom: boolean;
  readonly onToBottom: () => void;
}): ReactNode {
  const session = useUi((s) => s.session);
  const live = useUi((s) => s.live);
  const busy = useUi((s) => s.busy);
  const pendingInputs = useUi((s) => s.pendingInputs);
  const hero = isConversationHero({
    messageCount: session?.messages.length ?? 0,
    hasLiveMessage: live.message !== undefined,
    running: session?.status === 'running',
    busy,
    pendingCount: pendingInputs.length,
  });
  const workspace = workspaceLabel(session?.cwd);

  return (
    <div
      className={cn(CHAT_AXIS, 'conversation', hero ? 'conversation--hero' : 'conversation--docked')}
    >
      <div className={cn(CHAT_BODY, 'flex flex-col gap-6', hero && 'empty:hidden')}>
        <SetupBanner />
        <SessionConflictBanner />
        <NoticeBanner />
        <ExtRecordsBanner />
        <UntrustedBanner />
        {!hero && (
          <>
            <MessageStream messages={session?.messages ?? []} />
            <LiveMessage />
            <TurnStatus />
            <StatsLine />
          </>
        )}
      </div>
      <div className={cn('composer-seat', hero && 'composer-seat--hero')}>
        {!hero && (
          <div className="to-bottom-slot">
            {showToBottom && (
              <button
                type="button"
                className="to-bottom"
                aria-label="回到底部"
                title="回到底部"
                onClick={onToBottom}
              >
                <ToBottomIcon />
              </button>
            )}
          </div>
        )}
        {hero && (
          <div className="composer-hero-intro">
            <p className="composer-hero-intro__title">有什么要做的</p>
            {workspace !== undefined && (
              <p className="composer-hero-intro__meta" title={session?.cwd}>
                工作区 · {workspace}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col gap-2 empty:hidden">
          <InterruptedSessionBanner />
          <TurnErrorBanner />
        </div>
        <Composer disabled={busy} running={session?.status === 'running'} />
      </div>
    </div>
  );
}

function ToBottomIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
