import type { ReactNode } from 'react';
import { Disclosure } from './disclosure.js';
import { ASSISTANT_BODY, RoleLabel } from './message-stream.js';
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
  if (message === undefined) return null;
  /*
    容器样式必须和 `MessageView` 的助手分支**逐字一致**（共用 `ASSISTANT_BODY` / `RoleLabel`）。
    在途时套卡片、落库后变成无框正文的话，`message.end` 那一刻同一段文字会当着用户的面跳一下。
    等待文案改由 `TurnStatus` 的 shimmer 承担，这里只画已经冒出来的思考/正文。
  */
  if (message.thinking === '' && message.text === '') return null;

  return (
    <div>
      <RoleLabel>小明</RoleLabel>
      <div className={ASSISTANT_BODY}>
        {message.thinking !== '' && (
          <Disclosure label="思考中…" defaultOpen summaryClassName="text-meta">
            <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-meta text-muted">
              {message.thinking}
            </p>
          </Disclosure>
        )}
        {message.text !== '' && (
          <p className="whitespace-pre-wrap text-body">
            {/*
              在途文字**不过 Markdown**：半截的语法（一个还没闭合的 ``` 或 |）
              会让渲染结果在打字过程中反复跳变。落库之后的那一份才渲染。
            */}
            {message.text}
            {/* 光标：让"还在写"和"写完了但很短"这两种情况分得开 */}
            <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-accent align-text-bottom">
              &nbsp;
            </span>
          </p>
        )}
      </div>
    </div>
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
          className="flex items-baseline gap-2.5 rounded-control border border-border px-3 py-1.5 text-meta"
        >
          <span className="font-mono font-medium">{c.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted">
            {calls.get(c.callId)?.message ?? '运行中…'}
          </span>
          <span className="shrink-0 animate-pulse text-faint">进行中</span>
        </div>
      ))}
    </div>
  );
}
