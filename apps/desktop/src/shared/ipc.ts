import { z } from 'zod';
import {
  AgentId,
  BlobRef,
  CallId,
  Capability,
  CheckpointId,
  ConfigPatch,
  EventEnvelope,
  Message,
  MessageId,
  PermissionRequest,
  PtySessionId,
  RequestId,
  SessionId,
  Todo,
  TurnId,
  Usage,
  XmError,
} from '@xm/contracts';

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

export const ListSessionsResult = z.array(
  z.object({
    sessionId: SessionId,
    title: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastSeq: z.number().int().nonnegative(),
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
 * 会话状态的可过 IPC 镜像（ADR-0032，修 G4/G5）。
 *
 * ── 为什么不再是"整段事件数组"（`z.array(EventEnvelope)`）──
 *
 * 旧形状要求渲染层拿到全部历史事件后自己 `reduce()` 一遍——这在一个用了几个月、
 * 几万条事件的会话上会把主进程的 `structuredClone` 和渲染层的回放都卡到几百毫秒
 * （docs/09 G5 实测：5 万事件 685ms，两个进程各卡一次）。而主进程这时早就有一份
 * 现成的、已经 `reduce()` 过的 `SessionRuntime.state`——`readSession` 现在直接把
 * 它序列化过去，渲染层只做 `deserializeSessionState()`，不再重新回放历史。
 *
 * 这**没有**违反"渲染层不维护第二份状态"（ADR-0015）：状态仍然只有一处计算——
 * 主进程的 `reduce()`——渲染层只是消费结果，不再重复计算一遍。真正体现
 * "内核能在浏览器里跑"的场景（后续每一条实时事件）不受影响，渲染层照样对
 * 每条新事件调用 `reduce()`（见 `store.ts` 的 `applyEvent`），只有"打开会话时
 * replay 全部历史"这一次性的、纯粹昂贵的动作被挪到了主进程侧，且主进程本来就
 * 要维护这份状态（`runtimeFor()` 缓存的 `SessionRuntime` 实例），不是新增计算。
 *
 * ── 为什么不做深度 strict 校验 ──
 *
 * 这份数据始终是"主进程 → 渲染层"单向流动，且生产方（`serializeSessionState`）
 * 与消费方（`deserializeSessionState`）是同一份 `@xm/kernel` 代码——不存在
 * "渲染层需要提防主进程撒谎"这件事（真正需要提防的方向是反过来）。这里的字段级
 * schema 与 `EventEnvelope` 的"松"是同一个理由：**收益是版本一致性，不是安全**
 * （开发时热重载让两侧代码错开的那类问题），所以复合字段用 `z.unknown()`
 * 兜底而不是逐层展开每一种 `ContentBlock`/工具输入——那些已经在事件层校验过一次。
 */
const PermissionGrantSchema = z.object({
  requestId: RequestId,
  capability: Capability,
  target: z.string(),
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['session', 'always']),
  ts: z.number(),
});

const UntrustedContextSchema = z.object({
  callId: CallId,
  toolName: z.string(),
  viaCapability: Capability,
  since: z.number(),
});

const RunningCallSchema = z.object({ callId: CallId, name: z.string(), startedAt: z.number() });
const RunningSubagentSchema = z.object({
  agentId: AgentId,
  childSessionId: SessionId,
  purpose: z.string(),
  startedAt: z.number(),
});
const OpenPtySessionSchema = z.object({ ptySessionId: PtySessionId, cwd: z.string(), startedAt: z.number() });
const NoticeSchema = z.object({
  level: z.enum(['info', 'warn']),
  code: z.string(),
  message: z.string(),
  ts: z.number(),
});
const CheckpointSchema = z.object({
  checkpointId: CheckpointId,
  kind: z.enum(['fs', 'git']),
  ref: z.string(),
  label: z.string(),
  restoredAt: z.number().or(z.undefined()),
});
const CompactionSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
  summaryRef: BlobRef,
  tokensBefore: z.number(),
  tokensAfter: z.number(),
});
const UsageTotalsSchema = z.object({
  usage: Usage,
  costUsd: z.number(),
  turns: z.number(),
  unpricedTurns: z.number(),
});

/*
 * 下面这批可选字段一律用 `.or(z.undefined())` 而不是 `.optional()`——
 * 两者在 zod 里推出的 TS 类型不同：`.optional()` 让**键**变成可选
 * （`x?: T`），`.or(z.undefined())` 让键保持必填、只是值允许是
 * `undefined`（`x: T | undefined`）。`SerializedSessionState`（`@xm/kernel`）
 * 和它照抄的 `SessionState` 一样，字段全部写成后一种形状（原因见
 * `session-state.ts` 顶部注释：`exactOptionalPropertyTypes` 下 `x?: X`
 * 没法用 `{ ...state, x: undefined }` 清空）。这里选错一个，
 * `deserializeSessionState()` 的入参类型就对不上，会在类型层面被迫走
 * `as` 绕过去——那正是这条约定原本要防的事。
 */
export const SerializedSessionStateResult = z.object({
  id: SessionId,
  title: z.string(),
  cwd: z.string(),
  modelRef: z.string(),
  status: z.enum(['idle', 'running', 'waiting_permission', 'error']),
  messages: z.array(Message),
  activeTurn: z.object({ turnId: TurnId, startedAt: z.number() }).or(z.undefined()),
  activeMessage: z
    .object({
      messageId: MessageId,
      role: z.enum(['user', 'assistant']),
      model: z.string().or(z.undefined()),
      startedAt: z.number(),
    })
    .or(z.undefined()),
  pendingPermission: PermissionRequest.or(z.undefined()),
  grants: z.array(PermissionGrantSchema),
  untrustedContext: UntrustedContextSchema.or(z.undefined()),
  todos: z.array(Todo),
  runningCalls: z.array(z.tuple([CallId, RunningCallSchema])),
  interruptedCalls: z.array(RunningCallSchema),
  runningSubagents: z.array(z.tuple([AgentId, RunningSubagentSchema])),
  ptySessions: z.array(z.tuple([PtySessionId, OpenPtySessionSchema])),
  config: ConfigPatch,
  usage: UsageTotalsSchema,
  compactions: z.array(CompactionSchema),
  checkpoints: z.array(CheckpointSchema),
  notices: z.array(NoticeSchema),
  lastError: XmError.or(z.undefined()),
  lastSeq: z.number().int().nonnegative(),
});
export const ReadSessionResult = SerializedSessionStateResult;

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
 * 应答一次权限审批。
 *
 * ── `requestId` 为什么必须带 ──
 *
 * 不带的话，主进程只能"把当前挂着的那个请求应答掉"。而一次工具调用可能连着问两个
 * 能力，用户看到的是第一个、点下去时第二个已经上来了——那就是把"允许读"错当成
 * "允许写"。带上 id 之后，对不上的应答直接被丢掉。
 *
 * ── 没有 `by` 字段 ──
 *
 * 与 `ClearUntrustedRequest` 同一条纪律：应答者永远是人，这条 IPC 的到达本身就是
 * 全部含义。让渲染层报出自己是谁，等于给一个将来可能被 XSS 或插件 UI 驱动的进程
 * 一个可以撒谎的字段。
 */
export const RespondPermissionRequest = z.strictObject({
  sessionId: SessionId,
  requestId: RequestId,
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session', 'always']),
});
export const RespondPermissionResult = z.object({
  /** 有没有真的对上一个在等的请求。对不上时 UI 该把那张卡片收起来 */
  accepted: z.boolean(),
});

/**
 * 审批模式（docs/09 C6）——桌面层的纯 UI 概念，不进 `@xm/contracts`。
 *
 * 三档都落在已经实现、已经验证过的 `PermissionTier`（`balanced`/`yolo`）语义上，
 * 不新增、不修改 tier，也不碰 `evaluate()`：
 *
 *   - `ask`  —— 请求批准。今天的默认行为，映射到 `balanced`。
 *   - `auto` —— 帮我批准。跳过所有 `ask`（含 `shell.exec`），红线与任何 `deny`
 *                （含内置的敏感路径/持久化/SSRF/危险命令 deny，也含用户自己写的）
 *                原样生效——映射到已经过 ADR-0017/C5 验证过的 `yolo`。
 *   - `full` —— 完全访问权限。与 `auto` 是**同一套判定机制**（同样映射到 `yolo`），
 *                唯一区别在桌面 UI 的开启门槛（需要二次确认）与文案，而不是新开一个
 *                凌驾于红线之上的层级——"是否该越过红线"是 C6 明确要求单独拍板的
 *                问题，本轮刻意不做，见 ADR-0030。
 *
 * 会话级、不持久化，跟 docs/06 对 YOLO 开关的既有约束一致：新会话一律从 `ask` 起步，
 * 存在主进程内存里，不读写 `config.json`。
 */
export const ApprovalMode = z.enum(['ask', 'auto', 'full']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const GetApprovalModeRequest = z.strictObject({ sessionId: SessionId });
export const GetApprovalModeResult = z.object({ mode: ApprovalMode });

export const SetApprovalModeRequest = z.strictObject({ sessionId: SessionId, mode: ApprovalMode });
/** 回显真正生效的值，而不是假定请求里的值一定被采纳 */
export const SetApprovalModeResult = z.object({ mode: ApprovalMode });

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
