import { useEffect, useState, type ReactNode } from 'react';
import { liveWaitingPhase } from '../live-status.js';
import { formatDuration, formatStatsLine, sessionWallMs } from '../lib/turn-stats.js';
import { useUi } from '../store.js';

/**
 * 回合进行中：shimmer 文案 + 等宽数字计时，替掉原来的「运行中」脉冲。
 * 回合结束后这一支卸掉，换成下面的 StatsLine。
 */
export function TurnStatus(): ReactNode {
  const session = useUi((s) => s.session);
  const live = useUi((s) => s.live);
  const elapsed = useElapsed(session?.status === 'running' ? session.activeTurn?.startedAt : undefined);

  if (session?.status !== 'running') return null;
  const phase = live.message === undefined ? '工作中' : liveWaitingPhase(live.message) ?? '工作中';

  return (
    <p className="turn-status" role="status">
      <span className="turn-status-shimmer">{phase}</span>
      {elapsed !== undefined && (
        <span className="turn-status__elapsed">{formatDuration(elapsed)}</span>
      )}
    </p>
  );
}

/**
 * 回合结束一行居中统计。用量来自已有的 `session.usage`（reduce 对 `usage.recorded`
 * 的累加），用时来自首末消息时间戳——都不新增事件，也不维护第二份状态。
 */
export function StatsLine(): ReactNode {
  const session = useUi((s) => s.session);
  if (session === undefined || session.status === 'running') return null;
  const messages = session.messages;
  const first = messages[0]?.ts;
  const last = messages[messages.length - 1]?.ts;
  const line = formatStatsLine({
    inputTokens: session.usage.usage.inputTokens,
    outputTokens: session.usage.usage.outputTokens,
    wallMs: sessionWallMs(first, last),
    costUsd: session.usage.costUsd,
    unpricedTurns: session.usage.unpricedTurns,
  });
  if (line === undefined) return null;
  return <p className="stats-line">{line}</p>;
}

function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return undefined;
    const tick = (): void => {
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, now - startedAt);
}
