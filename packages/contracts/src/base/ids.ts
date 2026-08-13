import { z } from 'zod';

/**
 * 品牌化 ID。
 *
 * 为什么不用裸 string：`sessionId: string` 与 `callId: string` 在类型系统里毫无区别，
 * 参数传反了编译器一声不吭——而这类 bug 在事件系统里极难查（数据写进了错误的会话，
 * 且直到几天后 reduce 出奇怪的状态才被发现）。品牌化零运行时成本，纯类型层收益。
 *
 * 为什么用 UUIDv4 而不是 ULID/UUIDv7：会话内顺序由 `seq` 保证，跨会话顺序由 `ts` 保证，
 * ID 只需唯一。`crypto.randomUUID()` 在 Node 与浏览器都全局可用，零依赖——
 * 这对"契约包只依赖 zod"这条铁律很重要。
 */
const uuid = z.uuid();

export const SessionId = uuid.brand<'SessionId'>();
export const EventId = uuid.brand<'EventId'>();
export const TurnId = uuid.brand<'TurnId'>();
export const MessageId = uuid.brand<'MessageId'>();
export const CallId = uuid.brand<'CallId'>();
export const RequestId = uuid.brand<'RequestId'>();
export const AgentId = uuid.brand<'AgentId'>();
export const CheckpointId = uuid.brand<'CheckpointId'>();
export const EditProposalId = uuid.brand<'EditProposalId'>();
/** PTY 会话（`shell.session`，ADR-0031）。跨越单次工具调用存活，故不用 CallId */
export const PtySessionId = uuid.brand<'PtySessionId'>();

export type SessionId = z.infer<typeof SessionId>;
export type EventId = z.infer<typeof EventId>;
export type TurnId = z.infer<typeof TurnId>;
export type MessageId = z.infer<typeof MessageId>;
export type CallId = z.infer<typeof CallId>;
export type RequestId = z.infer<typeof RequestId>;
export type AgentId = z.infer<typeof AgentId>;
export type CheckpointId = z.infer<typeof CheckpointId>;
export type EditProposalId = z.infer<typeof EditProposalId>;
export type PtySessionId = z.infer<typeof PtySessionId>;

/**
 * ⚠️ 刻意不写成泛型工厂 `newId<T extends string>()`。
 *
 * 那种写法里类型参数只在返回值出现一次，等于伪装的类型断言——调用点把品牌写错
 * （`newId<'CallId'>()` 赋给 SessionId）编译器也不会报错。typed lint 的
 * no-unnecessary-type-parameters 会直接拦下（2026-08-04 冒烟实测抓到）。
 *
 * 逐类型显式构造器多几行，但调用点无法写错。
 */
/**
 * `crypto` 在 Node 19+ 与所有浏览器里都是全局的，但它的类型来自 DOM lib 或
 * @types/node —— 两者都不该被契约包引入（前者会让 document/fetch 也变成可见，
 * 削弱"内核纯逻辑"的编译期保证；后者直接违反零依赖铁律）。
 * 所以在这里就地声明所需的最小形状。
 */
const rawId = (): string =>
  (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto.randomUUID();

export const newSessionId = (): SessionId => rawId() as SessionId;
export const newEventId = (): EventId => rawId() as EventId;
export const newTurnId = (): TurnId => rawId() as TurnId;
export const newMessageId = (): MessageId => rawId() as MessageId;
export const newCallId = (): CallId => rawId() as CallId;
export const newRequestId = (): RequestId => rawId() as RequestId;
export const newAgentId = (): AgentId => rawId() as AgentId;
export const newCheckpointId = (): CheckpointId => rawId() as CheckpointId;
export const newEditProposalId = (): EditProposalId => rawId() as EditProposalId;
export const newPtySessionId = (): PtySessionId => rawId() as PtySessionId;
