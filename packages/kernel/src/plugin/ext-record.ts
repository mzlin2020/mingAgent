import type { XmEvent } from '@xm/contracts';
import { isExtEvent } from '@xm/contracts';

/**
 * 会话里出现过的插件事件，按 `pluginId` 汇总（ADR-0057 §三）。
 *
 * ── 为什么它不在 `SessionState` 里 ──
 *
 * `reduce()` 对插件事件恒等，一个字段都不加——否则删掉插件就无法 reduce 历史会话。
 * 但"事件不丢"与"UI 有说明"是同一条决策的另一半：一条读不懂的记录静静躺在库里、
 * 界面上什么也不显示，用户看到的就是"我的东西没了"。
 *
 * 所以汇总走**按类型过滤的一次读**（`ReadOptions.types`），不进状态、不进快照。
 * 代价是每次打开会话多一次带条件的查询；换来的是核心状态一个字段都没为插件让步。
 */
export interface ExtRecordSummary {
  readonly pluginId: string;
  /** 该插件的事件条数（本次读取范围内） */
  readonly count: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  /** 出现过的事件名，最多留 `MAX_NAMES` 个——它是给人看的线索，不是完整目录 */
  readonly names: readonly string[];
  /** 该插件当前是否装着。为 false 时 UI 显示"来自未安装的扩展" */
  readonly installed: boolean;
}

const MAX_NAMES = 8;

export const summarizeExtRecords = (
  events: Iterable<XmEvent>,
  installedPluginIds: ReadonlySet<string>,
): readonly ExtRecordSummary[] => {
  const byPlugin = new Map<string, { summary: ExtRecordSummary; names: Set<string> }>();

  for (const event of events) {
    if (!isExtEvent(event)) continue;
    const { pluginId, name } = event.payload;
    const found = byPlugin.get(pluginId);
    if (found === undefined) {
      byPlugin.set(pluginId, {
        summary: {
          pluginId,
          count: 1,
          firstSeq: event.seq,
          lastSeq: event.seq,
          names: [],
          installed: installedPluginIds.has(pluginId),
        },
        names: new Set([name]),
      });
      continue;
    }
    found.summary = {
      ...found.summary,
      count: found.summary.count + 1,
      lastSeq: event.seq,
    };
    if (found.names.size < MAX_NAMES) found.names.add(name);
  }

  return [...byPlugin.values()]
    .map((entry) => ({ ...entry.summary, names: [...entry.names].sort() }))
    .sort((a, b) => a.firstSeq - b.firstSeq);
};
