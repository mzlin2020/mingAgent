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
    /*
      配色从 token 读，不再写死。上一版是 `background: '#00000000'` + 外层 `bg-black/90`——
      外层那个纯黑在浅色主题下是界面上唯一一块高对比的死黑，很扎眼；而前景色一直没设，
      xterm 用的是它自己的默认白，与暖色调不搭。
      终端底色本身在明暗下相同：里面跑的是真实 ANSI 输出，底色跟着主题变浅会毁掉配色。
    */
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      convertEol: true,
      disableStdin: true, // v1 只读，见组件顶部注释
      fontSize: 12,
      fontFamily: css.getPropertyValue('--font-mono').trim(),
      theme: {
        background: '#00000000', // 透明，底色由外层容器的 bg-terminal-bg 提供
        foreground: css.getPropertyValue('--color-terminal-fg').trim(),
        cursor: css.getPropertyValue('--color-accent').trim(),
      },
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
    <Card className={cn('p-2', terminal.closed && 'opacity-70')}>
      <div className="mb-1.5 flex items-center justify-between px-1.5 pt-0.5 text-meta">
        <span className="min-w-0 truncate font-mono text-muted">{terminal.cwd}</span>
        <span className={cn('shrink-0', terminal.closed ? 'text-faint' : 'text-accent')}>
          {terminal.closed ? '已结束' : '运行中'}
        </span>
      </div>
      {/*
        深色主题下终端底色和卡片底色只差一点，不描边就看不出终端从哪里开始到哪里结束。
        浅色下这条边框也让那块深色不至于像是"糊上去的"。
      */}
      <div
        ref={containerRef}
        className="h-64 overflow-hidden rounded-control border border-border bg-terminal-bg p-2"
      />
    </Card>
  );
}
