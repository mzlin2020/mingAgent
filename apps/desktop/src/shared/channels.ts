/**
 * IPC 通道名。**只有常量，没有依赖。**
 *
 * 单独成文件是为了让 preload 能 import 它而不引入任何别的东西——
 * preload 跑在 `sandbox: true` 的上下文里，它每多一个依赖，隔离就薄一分。
 * depcruise 有一条规则盯着"preload 只许依赖 electron 与本文件"。
 *
 * Zod schema 在 `./ipc.ts`，由**主进程与渲染层**各自 import，preload 不参与校验：
 * 它是一根管子，不是一道闸门。把校验放进 preload 会让人误以为那里能挡住什么，
 * 而真正需要防的是"渲染层送上来的东西"，那必须在主进程这一侧挡。
 */

export const CH = {
  /** 渲染层 → 主进程，一问一答 */
  listSessions: 'xm:list-sessions',
  createSession: 'xm:create-session',
  sendUserMessage: 'xm:send-user-message',
  readSession: 'xm:read-session',
  /** 解除本会话的不可信标记。**只有人能按**，见 ADR-0019 */
  clearUntrusted: 'xm:clear-untrusted',
  /** 主进程 → 渲染层，单向推送 */
  event: 'xm:event',
} as const;
