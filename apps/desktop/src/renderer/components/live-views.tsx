import type { ReactNode } from 'react';
import { Card } from './ui.js';
import { useUi } from '../store.js';

/**
 * 在途消息（ADR-0021）—— 模型正在打字的那一条。
 *
 * 它渲染的是 `live`，不是 `session.messages`。两者在时间上互斥：`message.end` 一到，
 * `applyLive` 归零、`reduce` 把完整消息放进 `messages`，同一段文字换了个位置显示，
 * **不会同时出现两份**。这条互斥就是它不算"第二份状态"的全部理由。
 *
 * 在这个组件存在之前，`message.delta` 推到渲染层之后无人接收（`reduce` 里它是空操作），
 * 于是一次三十秒的流式回复期间界面完全静止（docs/09 G6）。
 */
export function LiveMessage(): ReactNode {
  const message = useUi((s) => s.live.message);
  if (message === undefined || (message.text === '' && message.thinking === '')) return null;

  return (
    <Card>
      <div className="mb-1 text-xs text-[var(--xm-fg-muted)]">小明</div>
      <div className="flex flex-col gap-2">
        {message.thinking !== '' && (
          <details className="text-xs text-[var(--xm-fg-muted)]" open>
            <summary className="cursor-pointer">思考中…</summary>
            <p className="mt-1 whitespace-pre-wrap">{message.thinking}</p>
          </details>
        )}
        {message.text !== '' && (
          <p className="whitespace-pre-wrap">
            {/*
              在途文字**不过 Markdown**：半截的语法（一个还没闭合的 ``` 或 |）
              会让渲染结果在打字过程中反复跳变。落库之后的那一份才渲染。
            */}
            {message.text}
            {/* 光标：让"还在写"和"写完了但很短"这两种情况分得开 */}
            <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-[var(--xm-fg)] align-text-bottom">
              &nbsp;
            </span>
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * 正在跑的工具及其最新进度（ADR-0021 的第二半）。
 *
 * `tool.progress` 与 `message.delta` 一样是瞬态事件，在 `reduce` 里同样是空操作——
 * 所以在这个组件存在之前，一次读几千个文件的调用期间界面上什么也不会变。
 *
 * 它读的是 `live.calls`，归零由 `tool.end` 负责。与在途文字不同的是：
 * 这里显示的内容**永远不会**出现在 `session.messages` 里（那里放的是工具的结果），
 * 所以它不是"先在 buffer 后在 state"，而是"用完就没了"。
 */
export function LiveCalls(): ReactNode {
  const calls = useUi((s) => s.live.calls);
  const running = useUi((s) => s.session?.runningCalls);
  if (running === undefined || running.size === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {[...running.values()].map((c) => (
        <div
          key={c.callId}
          className="rounded-md border border-[var(--xm-border)] px-3 py-2 text-xs"
        >
          <span className="font-mono font-medium">{c.name}</span>
          <span className="ml-2 text-[var(--xm-fg-muted)]">
            {calls.get(c.callId)?.message ?? '运行中…'}
          </span>
        </div>
      ))}
    </div>
  );
}
