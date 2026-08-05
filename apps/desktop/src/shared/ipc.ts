import { z } from 'zod';
import { EventEnvelope, SessionId } from '@xm/contracts';

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
});
export const CreateSessionResult = z.object({ sessionId: SessionId });

export const SendUserMessageRequest = z.strictObject({
  sessionId: SessionId,
  /** 上限刻意存在：一条无界的字符串从渲染层进来会直接变成一次无界的落库 */
  text: z.string().min(1).max(100_000),
});
export const SendUserMessageResult = z.object({ reason: z.string() });

export const ReadSessionRequest = z.strictObject({
  sessionId: SessionId,
  fromSeq: z.number().int().positive().optional(),
});
export const ReadSessionResult = z.array(EventEnvelope);

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
