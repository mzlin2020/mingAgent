import type { PersistedEvent, SessionId } from '@xm/contracts';
import { XmEvent, isPersistedEvent, redact } from '@xm/contracts';
import type { SerializedSessionState } from '../state/snapshot.js';

/**
 * 事件存储端口（ADR-0013）。
 *
 * 端口由内核定义、由适配层实现（docs/04 §1）。内核零 I/O，所以这里**只有类型**——
 * 但类型不是全部：底下这些不变量才是这个端口真正的内容，SQLite 适配器、
 * 内存实现、将来任何别的实现都必须逐条满足，`eventStoreContract()` 会挨条打。
 *
 * ── 七条不变量 ────────────────────────────────────────────────
 *
 * **一、`append` 是原子的。** 一批要么全落要么全不落。理由具体：一次工具调用产出
 * `tool.end` + `usage.recorded`，只落前一半，回放出的成本就永久少一截，而且没人会发现。
 *
 * **二、只接受持久化事件。** 类型层面就拒绝——`message.delta` 递进来编译不过
 * （`PersistedEvent` 从 `EVENT_SPECS` 的 durability 标注推导）。ADR-0008 的分层
 * 以前只有事后的包含性测试在拦，现在写入侧当场拦。
 *
 * **三、`seq` 由调用方分配，存储只验证。** 调用方用 `nextSeq(state.lastSeq)`，
 * 存储层的 `PRIMARY KEY(session_id, seq)` 是**并发写检测器**，不是索引优化。
 * 冲突即抛 `SeqConflictError`，**不重试、不重新分配**——那意味着有第二个写者，
 * 静默补救会把一次事故变成一段永远查不清的历史（docs/10 §4.1）。
 *
 * **四、写要先拿排他标记，读不用。** `openForWrite()` 取会话级排他标记（含 PID 与
 * 进程启动时间，用于识别陈旧标记）。WAL 下多读者 + 单写者，所以第二个窗口只读历史
 * 是允许的。
 *
 * **五、存储不做发布订阅。** 追加成功之后由 runtime 往事件总线上发——这样"谁通知"
 * 只有一个答案。若把通知放进存储，第二个进程就会想去轮询它，而轮询意味着它认为
 * 自己也能写。崩在追加与广播之间不会丢数据：订阅者重连时从自己的 `lastSeq` 续读即可。
 *
 * **六、落库的事件必须已脱敏。** 由 `SealedEvent` 这个品牌类型强制：`append` 只收
 * 封过的事件，而 `sealEvent()` 是唯一的生产者。ADR-0012 记下的"`redact()` 有契约、
 * 无执行点"就是在这里闭合的。
 *
 * **七、blob 先于引用它的事件落盘。** 事件里只放 `BlobRef`，若引用先于内容持久化，
 * 崩溃后就会留下指向不存在内容的事件——而事件是不可变的，这种坏引用永远修不掉。
 * `BlobStore` 端口另行定义（M0-b），但这条顺序约束现在就成立。
 *
 * **八、快照是可选的加速手段，绝不是第二个事实来源（ADR-0032，修 G4/G5）。**
 * `readSnapshot` 找不到、读不出、或者实现方干脆不存这张表，一律返回 `undefined`——
 * 调用方据此回退到从 seq 1 全量回放，这条回退路径必须永远正确，因为它就是
 * "没有快照机制"那个世界本来的样子。`writeSnapshot` 只需要保留"最新一份"就满足
 * 契约：旧快照没有任何独立价值，它能表达的一切都已经在事件流里，删了随时能从
 * 事件流重建。
 */

// ── 已脱敏的事件 ────────────────────────────────────────────────

declare const SEALED: unique symbol;

/**
 * "这条事件已经过统一脱敏出口"的**编译期证据**。
 *
 * 做成品牌类型而不是一句注释，是因为 ADR-0012 的教训：契约写了"入库前要过 redact()"
 * 却没有任何执行点，等于没写。现在绕过它需要显式的 `as`——那是一个 reviewer 看得见、
 * lint 拦得住的动作，而"忘了调用"是看不见的。
 */
export type SealedEvent = PersistedEvent & { readonly [SEALED]: true };

/**
 * 封存一条事件：脱敏 → 重新校验 → 打上品牌。
 *
 * 重新校验这步不是多余的。`redact()` 会改写值，改写有可能把 payload 弄得不再合法——
 * 这不是假想：键名正则里的 `token` 不带边界，一度会把 `usage.recorded` 的
 * `inputTokens: 1234` 换成 `'***'`。那种损坏若直接落库就是不可逆的。
 * 在这里当场炸掉，好过几个月后发现成本统计一直是错的。
 */
export function sealEvent(e: PersistedEvent): SealedEvent {
  const cleaned = XmEvent.parse(redact(e));
  if (!isPersistedEvent(cleaned)) {
    throw new Error(`事件 "${cleaned.type}" 是瞬态的，不该进存储（ADR-0008）。`);
  }
  return cleaned as SealedEvent;
}

// ── 端口 ────────────────────────────────────────────────────────

/**
 * 会话摘要 —— 存储层维护的**投影**，不是 reduce 出来的。
 *
 * 会话列表要显示标题和时间，而回放几百个会话只为了拿标题是荒唐的。所以这是这个系统里
 * 第一个读模型：由适配器在 `append` 的**同一个事务**里更新。同事务是关键——分两次写，
 * 崩在中间就会出现"事件在、列表里没有"的会话，用户再也找不到它。
 *
 * 投影可以随时从事件流重建（`rebuildSummaries()`），所以它坏了不算数据丢失。
 * 反过来说：**任何进不了摘要的信息都不许只存在于摘要里。**
 */
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 已落库的最大 seq。0 表示会话已创建但一条事件都没有 */
  readonly lastSeq: number;
  /** 子 Agent 会话指回父会话（docs/10 §4.1 不变量 4） */
  readonly parentSessionId?: SessionId;
}

export interface ReadOptions {
  /** 起始 seq，**含**。默认 1 */
  readonly fromSeq?: number;
  /** 结束 seq，**含**。默认读到末尾 */
  readonly toSeq?: number;
}

/**
 * 一份会话状态快照（ADR-0032）——`seq` 是这份状态对应的 `SessionState.lastSeq`，
 * 调用方从 `seq + 1` 起补读尾部事件即可拿到当前状态，不用从 1 全量回放。
 */
export interface StateSnapshot {
  readonly seq: number;
  readonly state: SerializedSessionState;
}

/**
 * 单写者句柄。持有它 = 持有该会话的排他标记。
 *
 * 刻意不把 `append` 直接挂在 `EventStore` 上：那样每次追加都得重新证明自己是唯一写者，
 * 而"证明"要么退化成每次一把锁（慢），要么退化成不检查（错）。把标记做成句柄的生命周期，
 * 拿不到就根本调不到 `append`。
 */
export interface SessionWriter {
  readonly sessionId: SessionId;
  /** 已落库的最大 seq，随 `append` 推进 */
  readonly lastSeq: number;

  /**
   * 原子追加。事件的 `seq` 必须从 `lastSeq + 1` 起连续。
   *
   * @throws {SeqConflictError} seq 不连续或已存在 —— 有第二个写者，或调用方算错了
   * @throws {WriteLeaseError}  排他标记已失效（进程被抢占、库被外部改动）
   */
  append(events: readonly SealedEvent[]): Promise<void>;

  /** 释放排他标记。幂等。 */
  close(): Promise<void>;
}

export interface EventStore {
  /**
   * 会话列表。读的是投影，不回放。
   *
   * 按 `updatedAt` 倒序——这是会话列表唯一的用法，让适配器在 SQL 里排序，
   * 好过每个调用点各排一遍还排得不一样。
   */
  listSessions(): Promise<readonly SessionSummary[]>;

  /**
   * 顺序读取一个会话的事件。
   *
   * 返回 `AsyncIterable` 而不是 `Promise<Event[]>` 是硬要求：一个用了几个月的会话有
   * 几万条事件，一次性物化会在打开会话时占掉几十 MB 并阻塞主进程。
   * `reduce` 本来就是逐条消费的，流式不增加任何调用方的复杂度。
   *
   * 会话不存在时产出空序列，**不抛**——"没有事件"和"没有会话"对读取方是同一件事。
   */
  read(sessionId: SessionId, options?: ReadOptions): AsyncIterable<PersistedEvent>;

  /**
   * 取得写句柄。会话不存在则创建，此时首条事件必须是 `seq=1` 的 `session.created`。
   *
   * @throws {WriteLeaseError} 该会话已被别的进程持有
   */
  openForWrite(sessionId: SessionId): Promise<SessionWriter>;

  /** 从事件流重建会话摘要投影。投影损坏或加了新字段时用。 */
  rebuildSummaries(): Promise<void>;

  /**
   * 读取会话的最新快照（不变量八）。没有就返回 `undefined`——**不抛**，
   * 语义与 `read()` 对不存在会话的处理一致："没有快照"不是错误。
   */
  readSnapshot(sessionId: SessionId): Promise<StateSnapshot | undefined>;

  /** 写一份快照，覆盖同一会话此前的快照（不变量八）。 */
  writeSnapshot(sessionId: SessionId, snapshot: StateSnapshot): Promise<void>;

  close(): Promise<void>;
}

// ── 错误 ────────────────────────────────────────────────────────

/**
 * seq 冲突：几乎总是意味着**同一会话有第二个写者**。
 *
 * 不可重试。见不变量三。
 */
export class SeqConflictError extends Error {
  // 参数属性写法被 erasableSyntaxOnly 禁掉（ADR-0010），字段只能显式声明
  readonly sessionId: SessionId;
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(sessionId: SessionId, expectedSeq: number, actualSeq: number) {
    super(
      `会话 ${sessionId} 的 seq 冲突：期望 ${String(expectedSeq)}，实际 ${String(actualSeq)}。` +
        `这通常意味着存在第二个写者——不做重试，见 ADR-0013 不变量三。`,
    );
    this.name = 'SeqConflictError';
    this.sessionId = sessionId;
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

/** 排他标记拿不到或已失效 */
export class WriteLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteLeaseError';
  }
}

/**
 * 库的 schema 版本高于本机 —— 拒绝打开。
 *
 * 与 `parseStoredEvent` 对未来版本事件的处理保持一致（ADR-0012 ⑤）：宁可打不开，
 * 也不要用旧代码的理解去解释新结构。区别只在层次——那条管 payload，这条管表结构。
 */
export class StoreVersionError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `事件库的 schema 版本 v${String(found)} 高于本机支持的 v${String(supported)}。` +
        `该库由更新版本的小明创建，请升级后再打开。`,
    );
    this.name = 'StoreVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/** schema_version 存在但不是严格的非负整数，说明元数据损坏。 */
export class StoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCorruptionError';
  }
}
