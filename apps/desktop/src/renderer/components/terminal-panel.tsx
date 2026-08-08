import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import type { LiveTerminal } from '@xm/kernel';
import { Card } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 打开着的 PTY 会话（`shell.session`，ADR-0031）。
 *
 * `live.terminals` 跨 turn 存活（见 `live-buffer.ts`），所以这里显示的是"当前会话
 * 打开过的全部终端"，不是"这一轮打开的"。已关闭的会话继续显示到用户手动收起
 * 为止——关闭前的最后输出往往正是用户想看的那部分。
 *
 * **v1 只读**：这里不接受用户直接往终端里敲字（没有接到 `shell.session.write`
 * 的输入通路）。是模型在开、模型在敲，人在看——这是 ADR-0004"观察面板"定位的
 * 直接延伸，也是本轮刻意收窄的范围（人能否接管打字，留给以后）。
 */
export function TerminalPanel(): ReactNode {
  const terminals = useUi((s) => s.live.terminals);
  if (terminals.size === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {[...terminals.values()].map((t) => (
        <TerminalView key={t.ptySessionId} terminal={t} />
      ))}
    </div>
  );
}

function TerminalView({ terminal }: { readonly terminal: LiveTerminal }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const writtenLength = useRef(0);

  // 挂载一次；仅在这一个终端会话的生命周期内存在
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const term = new Terminal({
      convertEol: true,
      disableStdin: true, // v1 只读，见组件顶部注释
      fontSize: 12,
      theme: { background: '#00000000' }, // 透明背景，跟随卡片自己的底色
    });
    term.open(el);
    termRef.current = term;
    writtenLength.current = 0;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [terminal.ptySessionId]);

  // 只写增量：`text` 是累积全文，重复 write 全量会让内容在终端里重影
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    if (terminal.text.length > writtenLength.current) {
      term.write(terminal.text.slice(writtenLength.current));
      writtenLength.current = terminal.text.length;
    }
  }, [terminal.text]);

  return (
    <Card className={cn(terminal.closed && 'opacity-70')}>
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--xm-fg-muted)]">
        <span className="font-mono">{terminal.cwd}</span>
        <span>{terminal.closed ? '已结束' : '运行中'}</span>
      </div>
      <div ref={containerRef} className="h-64 overflow-hidden rounded-sm bg-black/90 p-1" />
    </Card>
  );
}
