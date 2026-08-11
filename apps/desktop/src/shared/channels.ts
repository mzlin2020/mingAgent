/**
 * IPC 通道名。**只有常量，没有依赖。**
 *
 * 单独成文件是为了让 preload 能 import 它而不引入任何别的东西——
 *
 * ⚠️ 这里**没有**"读密钥"通道，而且不该有。密钥只从渲染层流向主进程，
 * 反向那条路一旦开出来，一次 XSS 或一个失控的插件 UI 就能把它读走。
 * 渲染层需要知道的只是"配没配"，那是 `status` 通道的一个 boolean。
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
  /**
   * 按 `BlobRef` 反查一张图片的字节，编成 data URL 供 `<img src>` 直接用。
   * 渲染层此前从未反查过 blob 内容，这是第一条——见 `services.readBlob` 的注释。
   */
  readBlob: 'xm:read-blob',
  /** 解除本会话的不可信标记。**只有人能按**，见 ADR-0019 */
  clearUntrusted: 'xm:clear-untrusted',
  /** 停止本会话正在跑的这一轮。ADR-0021 遗留的那个"没人发 message.interrupted"由它闭合 */
  interrupt: 'xm:interrupt',
  /**
   * 选一个工作目录。**路径由主进程的原生对话框产生**，不是渲染层拼一个字符串送上来——
   * 后者不算提权（判定用的是绝对路径、红线照样生效），但"这个目录是用户自己选的"
   * 这件事只有原生对话框能保证。
   */
  chooseWorkspace: 'xm:choose-workspace',
  /** 取运行状态：Provider 配没配好、密钥后端是哪一档、配置有没有问题 */
  status: 'xm:status',
  /**
   * 崩溃恢复（M1-e，docs/04 §8）。启动时扫描出的"停在没收尾回合里"的会话——
   * 不是"会话列表"的一部分，故意开独立通道，不牵连尚未排期的那个功能。
   */
  listOrphanedSessions: 'xm:list-orphaned-sessions',
  resumeOrphanedSession: 'xm:resume-orphaned-session',
  abandonOrphanedSession: 'xm:abandon-orphaned-session',
  /** 录入 API key。**只进不出**——没有对应的"读密钥"通道 */
  setApiKey: 'xm:set-api-key',
  /** 主进程 → 渲染层，单向推送 */
  event: 'xm:event',
} as const;
