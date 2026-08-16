/**
 * 工具行上要显示的短标题。只看 `card.kind`，不看任何工具名（ADR-0058 / M3-f）。
 *
 * 摘要仍用卡片自带的 `summary`。标题这一列需要更短：generic 用投影给的 `title`，
 * 其余三种用种类自己的固定词——渲染层因此仍然不认识任何具体工具。
 */

import type { ToolCard } from '@xm/contracts';

export function toolRowTitle(card: ToolCard): string {
  switch (card.kind) {
    case 'generic':
      return card.title;
    case 'terminal':
      return card.command.trim() === '' ? '终端' : card.command;
    case 'diff':
      return '编辑';
    case 'search':
      return card.query === undefined || card.query.trim() === '' ? '搜索' : card.query;
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
}
