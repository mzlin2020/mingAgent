import { ALL_EVENT_TYPES } from '@xm/contracts';
import type { InvariantEvent, InvariantInstaller } from '@xm/kernel';
import { payloadLooksLikeOccupancy } from './context-occupancy.js';

const countBlocks = (state: InvariantEvent['before']): number =>
  state.messages.reduce((total, message) => total + message.blocks.length, 0);

/**
 * `@xm/runtime` 的运行时不变量（ADR-0060）。
 *
 * 这个包拥有回合的驱动，所以回合的开合关系归它断言。工具调用的配对、seq 的连续性
 * 归 `@xm/kernel`——**跨包的关系归属给拥有那条事件流的包**，不重复断言。
 */
export const runtimeInvariants: InvariantInstaller = (api) => {
  /*
   * 一个会话在同一时刻只有一个打开的回合。
   *
   * 这条不是形式主义：`turn.end` 会把 `runningCalls` 整个搬进 `interruptedCalls`
   * （见 reduce），所以两个回合叠在一起时，后开的那个一收尾就会把前一个正在跑的调用
   * 全部标成"被中断"。表现是崩溃恢复扫描出一堆莫名其妙的孤儿回合，
   * 而根因在几百条事件之前。
   */
  api.on(['turn.start'], '同一时刻只有一个打开的回合', ({ event, before }) =>
    before.activeTurn === undefined
      ? undefined
      : `回合 ${before.activeTurn.turnId} 还没收尾，回合 ${event.payload.turnId} 就开始了。`,
  );

  api.on(['turn.end'], 'turn.end 收的必须是当前打开的那个回合', ({ event, before }) => {
    if (before.activeTurn === undefined) {
      return `没有打开的回合，却收到了 ${event.payload.turnId} 的 turn.end。`;
    }
    return before.activeTurn.turnId === event.payload.turnId
      ? undefined
      : `打开的是回合 ${before.activeTurn.turnId}，收尾的却是 ${event.payload.turnId}。`;
  });

  /*
   * 占用投影不得进事件流（M3.5-f）。
   *
   * 它是随事件同行的 sidecar，和卡片一样。写进 payload 就会被 reduce 忽略、
   * 被 loose schema 留下，重开会话对不上——而且那种错是静默的。
   * 盯全部已知类型：未知类型进不了 `record()`，这条断言的职责是挡住
   * "塞进已有事件"那条路。
   */
  api.on([...ALL_EVENT_TYPES], '占用投影不得进事件流', ({ event }) =>
    payloadLooksLikeOccupancy(event.payload)
      ? `事件 ${event.type} 的 payload 携带了占用投影字段（systemTokens / toolsTokens / conversationTokens / capacityTokens）。占用投影不落库、不参与 reduce、不进模型请求。`
      : undefined,
  );

  /*
   * 注入必须落库（ADR-0056 / 不变量八点五：模型可见 ⟺ 已落库）。
   *
   * `context.injected` 是持久事件，落库这件事由类型保证；这里断言的是另一半——
   * 它**真的进了消息流**。只落事件不进 messages，模型这一轮仍然看不到它，
   * 而这种不一致是静默的：不报错，只让模型莫名其妙忘掉一件事。
   */
  api.on(['context.injected'], '注入的内容必须进入消息流', ({ event, before, after }) => {
    /*
     * 判据是**块数**而不是消息条数：注入落在末尾是用户消息时会并进那一条
     * （`appendInjectedMessage`），条数一位不动。按条数写的第一版会在最常见的
     * 那条路径上误报——这正是"不变量写不好比不写更伤"的具体形状。
     */
    const expected = countBlocks(before) + event.payload.content.length;
    const actual = countBlocks(after);
    return actual === expected
      ? undefined
      : `注入了 ${String(event.payload.content.length)} 块内容，消息流的块数却从 ` +
          `${String(countBlocks(before))} 变成 ${String(actual)}（应为 ${String(expected)}）。`;
  });
};
