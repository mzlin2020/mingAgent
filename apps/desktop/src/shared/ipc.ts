import { z } from 'zod';
import { BlobRef, EventEnvelope, SessionId } from '@xm/contracts';

/**
 * IPC 载荷契约（ADR-0015）。
 *
 * ── 为什么两边都校验 ──
 *
 * **主进程不信任渲染层。** 渲染层将来要渲染模型输出、网页内容、插件 UI；
 * 一个 XSS 或一个失控的插件就能让它往 IPC 上发任意东西，而主进程这一侧握着
 * 文件系统、数据库和权限闸门。`contextIsolation` 挡的是"页面脚本直接拿到 Node"，
 * 挡不住"页面脚本调用我们自己开的这几个接口"。
 *
 * **渲染层也校验主进程送来的事件。** 这一侧的收益不是安全，是**版本一致性**：
 * 打包后的渲染层与主进程理论上同版本，但开发时热重载会让两边错开，
 * 而"事件形状悄悄变了"的表现是 UI 静默少一块。顺带，它把"契约包必须能在浏览器
 * 上下文里 import"从 depcruise 的静态承诺变成了运行时事实。
 *
 * 用 `EventEnvelope`（loose）而不是 `XmEvent`（判别联合）：渲染层拿到未知类型的事件
 * 应该原样忽略并继续，不该整条流断掉——那是版本漂移的正常形态，不是错误。
 */

/**
 * 会话列表里的粗粒度状态徽标（M1-e 会话列表状态整合）。刻意不叫 `SessionStatus`——
 * 那个名字被 `@xm/kernel` 占用，语义是单会话回放后的状态（下方
 * `SerializedSessionStateResult.status`），只有打开过的会话才低成本可得。这里是
 * **跨全部会话的列表投影**，值纯读主进程两张既有内存 Map 拼出来（`running`/
 * `orphanedSessions`，见 `services.ts`）——不是新的持久化状态源。
 */
export const SessionListStatus = z.enum(['idle', 'running', 'interrupted']);
export type SessionListStatus = z.infer<typeof SessionListStatus>;

export const ListSessionsResult = z.array(
  z.object({
    sessionId: SessionId,
    title: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastSeq: z.number().int().nonnegative(),
    status: SessionListStatus,
  }),
);
export type ListSessionsResult = z.infer<typeof ListSessionsResult>;

export const CreateSessionRequest = z.strictObject({
  title: z.string().max(200).optional(),
  /**
   * 会话的工作目录。省略则用家目录。
   *
   * 渲染层能送任意字符串上来，而这**不是**一条提权路径：判定用的是网关解析出的
   * 绝对路径，红线照样生效。它决定的只是"相对路径相对谁"。
   * 正常路径是先调 `chooseWorkspace` 让用户在原生对话框里选。
   */
  cwd: z.string().max(4096).optional(),
});
export const CreateSessionResult = z.object({ sessionId: SessionId });

/** 单条消息最多带几张图——8 是"够用又不至于一条消息喂爆一次请求"的经验值 */
export const MAX_IMAGES_PER_MESSAGE = 8;
/** 单图原始字节上限。精确校验在 main 侧解码 base64 之后再做一次，这里只挡明显超标的 */
export const MAX_IMAGE_RAW_BYTES = 10 * 1024 * 1024;
/** base64 会把字节数膨胀到 4/3 左右，这里的上限留了余量，只是 zod 的粗筛 */
export const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024;

export const ImageAttachment = z.strictObject({
  /** 原始字节的 base64。渲染层用 FileReader.readAsDataURL() 拿到后剥掉 data: 前缀传上来 */
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  mime: z.string().min(1).max(100),
  name: z.string().max(200).optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

/**
 * `text` 与 `images` 是**或**的关系，不是各自必填——允许"只发图片、不带文字"。
 * `.refine()` 兜住"两者都是空"这种输入：渲染层的 Composer 会在本地先挡一遍，
 * 但主进程不信任渲染层，这道闸门必须重开一次。
 */
export const SendUserMessageRequest = z
  .strictObject({
    sessionId: SessionId,
    /** 上限刻意存在：一条无界的字符串从渲染层进来会直接变成一次无界的落库 */
    text: z.string().max(100_000),
    images: z.array(ImageAttachment).max(MAX_IMAGES_PER_MESSAGE).optional(),
  })
  .refine((v) => v.text.trim() !== '' || (v.images?.length ?? 0) > 0, {
    message: '消息不能同时不带文字和图片',
  });
export const SendUserMessageResult = z.object({ reason: z.string() });

/**
 * 渲染层反查一个 blob 的字节——**第一条**这样的通道。此前 `stores.blobs` 只在
 * 主进程内部用（checkpoint 快照、超限工具结果的归档），渲染层从没读过 blob 内容。
 * `BlobRef` 本身（hash/mime/size/name）渲染层早就从事件流里见过了，
 * 这里不需要额外传 sessionId 做二次授权：能读到这条事件本身就代表这个会话看得见它。
 */
export const ReadBlobRequest = z.strictObject({ ref: BlobRef });
export const ReadBlobResult = z.object({ dataUrl: z.string() });

export const ReadSessionRequest = z.strictObject({ sessionId: SessionId });

/**
 * 会话状态的可过 IPC 镜像——拆到独立文件 `ipc-session-state.ts`（规模纪律，
 * docs/01 原则七/ADR-0032）。`export *` 原样接上，消费方仍然只从 `shared/ipc.js`
 * 导入，感觉不到这条分界线。
 */
export * from './ipc-session-state.js';

/**
 * 解除本会话的不可信标记（ADR-0019）。
 *
 * 载荷里**没有**"解除者"字段：解除者永远是人，而这条 IPC 的到达本身就是"人点了按钮"
 * 的唯一含义。让渲染层报出自己是谁，等于给一个将来可能被 XSS 或插件 UI 驱动的进程
 * 一个可以撒谎的字段。事件里的 `by: 'user'` 由主进程填。
 */
export const ClearUntrustedRequest = z.strictObject({
  sessionId: SessionId,
  reason: z.string().max(500).optional(),
});
export const ClearUntrustedResult = z.object({ cleared: z.boolean() });

/**
 * 停止本会话正在跑的这一轮。
 *
 * 返回"有没有东西被停下"而不是 void：用户连点两次停止时，第二次的答案是 false，
 * UI 据此不必再显示一遍"正在停止"。
 */
export const InterruptRequest = z.strictObject({ sessionId: SessionId });
export const InterruptResult = z.object({ interrupted: z.boolean() });

/**
 * 崩溃恢复（M1-e，docs/04 §8）。启动时扫描出的"停在没收尾回合里"的会话——独立
 * 通道，**仍然**不合并进 `ListSessionsResult`：`status === 'interrupted'` 只在
 * 列表上画一个徽标，这里的 `kind` 才携带继续/放弃动作需要的文案分类；两者靠
 * `sessionId` 关联（同一份主进程状态在不同粒度上曝光两次），不拍平成一个新结构。
 *
 * `kind` 不携带 `OrphanedTurn` 的其余细节——那些只在 `resumeOrphanedSession`/
 * `abandonOrphanedSession` 处理器里当场重新算一遍（不信任扫描时的旧缓存）。
 */
export const OrphanedSessionKind = z.enum(['message', 'tool', 'none']);
export type OrphanedSessionKind = z.infer<typeof OrphanedSessionKind>;

export const ListOrphanedSessionsResult = z.array(z.object({ sessionId: SessionId, kind: OrphanedSessionKind }));
export type ListOrphanedSessionsResult = z.infer<typeof ListOrphanedSessionsResult>;

export const ResumeOrphanedSessionRequest = z.strictObject({ sessionId: SessionId });
/** `resolved: false` = 扫描时的旧缓存已经过期（比如已经被处理过一次），UI 该把这一条收起来 */
export const ResumeOrphanedSessionResult = z.object({ resolved: z.boolean() });

export const AbandonOrphanedSessionRequest = z.strictObject({ sessionId: SessionId });
export const AbandonOrphanedSessionResult = z.object({ resolved: z.boolean() });

/*
 * ── 这里曾经有 `RespondPermission*` 与 `ApprovalMode`（三档审批模式）──
 *
 * 前者是"用户在审批卡片上点了本次/本会话/永久/拒绝"这条 IPC，后者是头部那个
 * 请求批准 / 帮我批准 / 完全访问权限的切换器（ADR-0030）。ADR-0039 把审批整体删除，
 * 两组契约一起消失。
 *
 * 两条当时想清楚了、将来若再引入类似 IPC 仍然成立的纪律留在这里：
 *
 *   · **`requestId` 必须带。** 不带的话主进程只能"把当前挂着的那个应答掉"，
 *     而一次调用可能连着问两个能力——用户看到的是第一个、点下去时第二个已经上来了，
 *     那就是把"允许读"错当成"允许写"。
 *   · **没有 `by` 字段。** 与 `ClearUntrustedRequest` 同一条纪律：动作的发起者永远是人，
 *     这条 IPC 的到达本身就是全部含义。让渲染层报出自己是谁，等于给一个将来可能被
 *     XSS 或插件 UI 驱动的进程一个可以撒谎的字段。
 */

/** 选工作目录。用户取消时 `path` 缺省——取消不是错误 */
export const ChooseWorkspaceResult = z.object({ path: z.string().optional() });

/**
 * 运行状态。**注意这里面没有任何密钥的值**——只有"配没配"。
 *
 * `secretBackend` 要暴露给渲染层，是因为降级横幅得说清楚现在是哪一档
 * （钥匙串 / 加密文件 / 存不了）。这三个字符串本身不敏感。
 */
export const StatusResult = z.object({
  providerReady: z.boolean(),
  providerId: z.string(),
  model: z.string(),
  secretBackend: z.enum(['keychain', 'encrypted-file', 'plaintext-unavailable']),
  hasApiKey: z.boolean(),
  configProblems: z.array(z.object({ code: z.string(), message: z.string() })),
  security: z.object({
    boundary: z.literal('host-autonomous-protected-core'),
    osSandbox: z.literal(false),
    protectedResources: z.array(z.string()),
    enabledTools: z.array(z.string()),
    disabledTools: z.array(z.string()),
    unavailableTools: z.array(z.string()),
    terminalMode: z.literal('controlled-argv-no-stdin'),
    logRedaction: z.literal(true),
  }),
});

/**
 * 录入 API key。
 *
 * `key` 有长度上限但**没有格式校验**：各家的 key 形状不同，兼容端点更是五花八门，
 * 在这里做格式判断只会把合法的 key 挡在门外，而挡不住任何攻击——
 * 这个通道的风险不是"传进来一个坏 key"，是"把 key 传出去"，而那条路根本不存在。
 */
export const SetApiKeyRequest = z.strictObject({
  providerId: z.string().min(1).max(64),
  key: z.string().min(1).max(4096),
});
export const SetApiKeyResult = z.object({ ok: z.literal(true) });

/** 主进程 → 渲染层的事件推送 */
export const PushedEvent = EventEnvelope;
export type PushedEvent = z.infer<typeof PushedEvent>;

/**
 * 一问一答的统一信封。
 *
 * 主进程**不把异常直接扔过 IPC**：Electron 会把它序列化成一个丢了类型、丢了 code、
 * 只剩字符串的东西，UI 拿它没法给出正确的下一步引导（contracts/base/error.ts 里
 * 区分 policy_denied / user_rejected / permission_denied 就是为了这个）。
 * 所以失败也是一个正常的返回值。
 */
export const IpcFailure = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});

/**
 * 信封先解、载荷后解，**分两步**。
 *
 * 写成 `ipcResult(schema)` 那种一步到位的泛型工厂更好看，但泛型判别联合在调用点
 * narrow 不出来（Zod 4 推出来的是一个巨大的映射类型，`.ok` 分不开两支）。
 * 分两步的类型是平凡的，而这里是边界代码——边界上宁可朴素。
 */
export const IpcEnvelope = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  IpcFailure,
]);
export type IpcEnvelope = z.infer<typeof IpcEnvelope>;
