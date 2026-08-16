/**
 * 回合统计文案（M3.5-c）。
 *
 * 数据来自 `session.usage`（`usage.recorded` 累加）与消息时间戳，不新增事件。
 * `costUsd: 0` 与「不知道花了多少」是两回事——后者靠 `unpricedTurns`，
 * 显示成 `$0.00` 就是一个自信的错数字。
 */

export interface TurnStatsInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallMs: number | undefined;
  readonly costUsd: number;
  readonly unpricedTurns: number;
}

const formatCount = (n: number): string => n.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${String(sec)}s`;
  const minutes = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${String(minutes)}m ${String(remain).padStart(2, '0')}s`;
}

/**
 * 花费这一段。`unpricedTurns > 0` 且累计仍是 0 → 整段未知；
 * 有一部分计价、一部分没有 → 写出已计价的数并标明未计价次数。
 */
export function formatCost(costUsd: number, unpricedTurns: number): string {
  if (unpricedTurns > 0 && costUsd === 0) return '未知';
  const amount = `$${costUsd.toFixed(4)}`;
  if (unpricedTurns > 0) return `${amount}（${String(unpricedTurns)} 次未计价）`;
  return amount;
}

export function formatStatsLine(input: TurnStatsInput): string | undefined {
  const hasTokens = input.inputTokens > 0 || input.outputTokens > 0;
  const hasCost = input.costUsd > 0 || input.unpricedTurns > 0;
  const hasTime = input.wallMs !== undefined && input.wallMs >= 0;
  if (!hasTokens && !hasCost && !hasTime) return undefined;

  const parts: string[] = [];
  if (hasTokens) {
    parts.push(`${formatCount(input.inputTokens)} / ${formatCount(input.outputTokens)}`);
  }
  if (input.wallMs !== undefined && input.wallMs >= 0) parts.push(formatDuration(input.wallMs));
  if (hasTokens || hasCost) parts.push(formatCost(input.costUsd, input.unpricedTurns));
  return parts.join(' · ');
}

/** 会话墙钟：第一条消息到最后一条。没有消息就没有用时，不编一个 0。 */
export function sessionWallMs(
  firstTs: number | undefined,
  lastTs: number | undefined,
): number | undefined {
  if (firstTs === undefined || lastTs === undefined) return undefined;
  const wall = lastTs - firstTs;
  return wall >= 0 ? wall : undefined;
}
