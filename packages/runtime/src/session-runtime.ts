import type {
  EventOf,
  PersistedEvent,
  SessionId,
  TurnId,
  XmEvent,
  XmEventType,
} from '@xm/contracts';
import { createEvent, isPersistedType } from '@xm/contracts';
import type { EventStore, SessionState, SessionWriter } from '@xm/kernel';
import {
  deserializeSessionState,
  emptySessionState,
  nextSeq,
  reduce,
  sealEvent,
  serializeSessionState,
} from '@xm/kernel';
import type { EventBus } from './event-bus.js';

/**
 * 每写入这么多条持久事件就存一份状态快照（ADR-0032，修 G4）。
 *
 * 与 `SqliteEventStore` 分页读取的 `READ_PAGE`（500）取同一个数量级不是巧合：
 * 快照命中之后最多补读一页，回放成本从"随全部历史线性增长、且因为每条
 * `message.end` 都整段拷贝 `messages` 数组而实际超线性"降到"一个有界常数"。
 */
const SNAPSHOT_INTERVAL = 500;

/**
 * 子 Agent 的污点回传尚未实现（ADR-0033 · G2）。
 *
 * `reduce()` 已经能处理 `subagent.start`/`subagent.end`（`packages/kernel/src/state/reduce.ts`），
 * 但只做了 `runningSubagents` 的记账——子会话的 `untrustedContext` 不会在 `subagent.end` 时
 * 并回父会话。派一个子 Agent 去读网页，是当前设计下完整的注入防御绕过路径。
 *
 * 这道闸门刻意不放进 `reduce()`：`reduce()` 要对它声明过的整个事件词表保持"全"，
 * 已有测试拿合法的 `subagent.start`/`subagent.end` 事件驱动它验证持久化包含性/快照往返，
 * 让 `reduce()` 在这里抛错会连累这些无关断言。正确的位置是写入边界——`record()` 是全系统
 * 唯一分配 `seq` 的地方，任何未来代码想让这两种事件落库，绕不开这里。
 *
 * M1 没有任何真正派生子 Agent 的载体，此时实现污点合并等于在从未跑过的真实输入上
 * 再造一次"测试全绿"（与 MCP 侧的 `UnimplementedMcpTaintPropagationError` 同一个理由）。
 */
export class UnimplementedSubagentTaintPropagationError extends Error {
  readonly eventType: 'subagent.start' | 'subagent.end';

  constructor(eventType: 'subagent.start' | 'subagent.end') {
    super(
      `子 Agent 的污点回传尚未实现（ADR-0033 · G2）：docs/09 的既定倾向是在 subagent.end 时` +
        `把子会话的 untrustedContext 并回父会话，但 M1 没有任何真正派生子 Agent 的载体，此时` +
        `实现它等于在从未跑过的真实输入上再造一次"测试全绿"。事件 "${eventType}" 在污点回传` +
        `实现之前不允许被记录。要让这个错误消失，在 M2 落地子 Agent 的真实派生路径时一并实现` +
        `污点合并，并删除这道闸门。`,
    );
    this.name = 'UnimplementedSubagentTaintPropagationError';
    this.eventType = eventType;
  }
}

/**
 * 一个会话的运行时：**全系统唯一分配 `seq` 的地方**。
 *
 * ADR-0013 的不变量三、五、六在这里从"类型上做得到"变成"代码里只有一条路"：
 *
 *   三（seq 由调用方分配，存储只验证）—— `#lastSeq` 只在这里推进，别处拿不到它
 *   五（存储不做发布订阅）—— 广播严格排在 `append` 成功之后
 *   六（落库的事件必须已脱敏）—— 出口只有一个，那里调 `sealEvent()`
 *
 * 瞬态事件（`message.delta` / `tool.progress`）走同一个出口，但**不落库、不占 seq**：
 * 它们复用上一条持久事件的 seq，只是为了让订阅者知道自己挂在哪个位置之后
 * （ADR-0008 / contracts `createEvent` 的 seq 约定）。
 */
export class SessionRuntime {
  readonly #store: EventStore;
  readonly #bus: EventBus;
  readonly #writer: SessionWriter;
  readonly #now: () => number;
  readonly sessionId: SessionId;

  #state: SessionState;
  #closed = false;
  /** 上一份快照对应的 `lastSeq`；开会话时没有快照就是 0（等同于"从没存过"）。 */
  #lastSnapshotSeq: number;
  /** 防重入闸门，见 `#maybeSnapshot()` 顶部注释 */
  #snapshotting = false;

  private constructor(
    sessionId: SessionId,
    store: EventStore,
    bus: EventBus,
    writer: SessionWriter,
    state: SessionState,
    now: () => number,
    lastSnapshotSeq: number,
  ) {
    this.sessionId = sessionId;
    this.#store = store;
    this.#bus = bus;
    this.#writer = writer;
    this.#state = state;
    this.#now = now;
    this.#lastSnapshotSeq = lastSnapshotSeq;
  }

  /**
   * 打开会话：取写句柄 → 读快照（若有）→ 只回放快照之后的尾部事件（ADR-0032，修 G4）。
   *
   * 没有快照（新会话、老库还没升级过、快照写失败过）时**回退到原来的全量回放**——
   * 这条回退路径必须永远正确，因为它就是"没有快照机制"那个世界本来的样子
   * （端口不变量八）。回放依然用 `for await`，一条一条过 `reduce`，不物化整个数组。
   */
  static async open(options: {
    readonly sessionId: SessionId;
    readonly store: EventStore;
    readonly bus: EventBus;
    readonly now?: () => number;
  }): Promise<SessionRuntime> {
    const { sessionId, store, bus } = options;
    const writer = await store.openForWrite(sessionId);

    const snapshot = await store.readSnapshot(sessionId);
    let state = snapshot === undefined ? emptySessionState(sessionId) : deserializeSessionState(snapshot.state);
    const readOptions = snapshot === undefined ? undefined : { fromSeq: snapshot.seq + 1 };
    for await (const e of store.read(sessionId, readOptions)) state = reduce(state, e);

    return new SessionRuntime(
      sessionId,
      store,
      bus,
      writer,
      state,
      options.now ?? Date.now,
      snapshot?.seq ?? 0,
    );
  }

  get state(): SessionState {
    return this.#state;
  }

  get lastSeq(): number {
    return this.#state.lastSeq;
  }

  /**
   * 记录一条事件：分配 seq → （持久事件）封存并落库 → 更新状态 → 广播。
   *
   * 顺序是**有意义的**，尤其是最后两步：广播必须在 `append` 成功之后。
   * 反过来（先广播再落库）在追加失败时会让订阅者看到一条并不存在的事件，
   * 而事件流是唯一真相——UI 上多出来一条永远回放不出来的消息，
   * 是那种用户报"它自己删了我的消息"、开发者查不出来的问题。
   */
  async record<T extends XmEventType>(input: {
    readonly type: T;
    readonly payload: EventOf<T>['payload'];
    readonly turnId?: TurnId;
  }): Promise<EventOf<T>> {
    if (this.#closed) throw new Error(`会话 ${this.sessionId} 的运行时已关闭。`);

    // 子 Agent 污点传播闸门（ADR-0033 · G2）——挡在写入边界，reduce() 保持全
    if (input.type === 'subagent.start' || input.type === 'subagent.end') {
      throw new UnimplementedSubagentTaintPropagationError(input.type);
    }

    const persisted = isPersistedType(input.type);
    const event = createEvent({
      type: input.type,
      sessionId: this.sessionId,
      // 瞬态事件复用上一条持久事件的 seq，不推进 seq 空间
      seq: persisted ? nextSeq(this.#state.lastSeq) : this.#state.lastSeq,
      ts: this.#now(),
      payload: input.payload,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });

    if (persisted) {
      await this.#writer.append([sealEvent(event as XmEvent as PersistedEvent)]);
    }

    this.#state = reduce(this.#state, event);
    this.#bus.publish(event);

    if (persisted) await this.#maybeSnapshot();

    return event;
  }

  /**
   * 每隔 `SNAPSHOT_INTERVAL` 条持久事件存一份快照。
   *
   * **快照写失败不向上抛。** 事件已经落库成功——这一步只是加速下一次 `open()`
   * 的手段（端口不变量八），失败的后果顶多是"下次多回放一段"，不该让它反过来
   * 拖垮已经成功的写入路径。失败会记一条 `notice.posted`——内核与运行时不做
   * 控制台输出（`eslint.config.js` 的 `no-console`，日志走事件流），用户能在
   * UI 里看到这条提示，不是只有开发者盯着终端才知道。
   *
   * `#snapshotting` 是防重入闸门：上面那条 `notice.posted` 本身也是持久事件，
   * 会经同一个 `record()` 再触发一次 `#maybeSnapshot()`——若不挡住，一次真实
   * 失败会变成"发通知→再次触发→再失败→再发通知"的无限递归。挡住之后，
   * 下一次真正的新事件到来时会正常重试，不会永远卡死在失败状态。
   */
  async #maybeSnapshot(): Promise<void> {
    if (this.#snapshotting) return;
    if (this.#state.lastSeq - this.#lastSnapshotSeq < SNAPSHOT_INTERVAL) return;

    this.#snapshotting = true;
    try {
      const seq = this.#state.lastSeq;
      try {
        await this.#store.writeSnapshot(this.sessionId, { seq, state: serializeSessionState(this.#state) });
        this.#lastSnapshotSeq = seq;
      } catch (err) {
        await this.record({
          type: 'notice.posted',
          payload: {
            level: 'warn',
            code: 'snapshot_write_failed',
            message: `会话状态快照写入失败（不影响已保存的事件，下次打开会话会多回放一段）：${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
      }
    } finally {
      this.#snapshotting = false;
    }
  }

  /**
   * 用户显式解除本会话的不可信标记 —— **G1 的唯一入口**。
   *
   * ── 为什么必须有它 ──
   *
   * `PolicyEngine` 在注入降级把 ask 打成 deny 时，原话是"请显式解除本轮的不可信标记后重试"。
   * 在这个方法存在之前，那句话是**一句无法兑现的承诺**：`untrustedContext` 一旦置上就是终身的。
   * 后果不是"防御太严"，是"防御会被整体放弃"——任何查过一次资料的会话都永久做不了
   * 不可撤销的操作，用户唯一的出路是新建会话，而他从中学到的经验是"别用这个功能"。
   *
   * ── 为什么在 runtime 而不是在桌面外壳 ──
   *
   * 桌面、CLI（M3）、headless 冒烟走同一条路。解除是安全决定，它只能有一个实现。
   *
   * ── 为什么工具调不到它 ──
   *
   * `ToolContext` 是 `{ sessionId, signal, cwd, executor }`——**工具拿不到 runtime，
   * 也拿不到任何记录事件的入口**。所以"读了网页的模型让工具把自己解除掉"这条路
   * 不是靠约定挡住的，是结构上不存在。`tests/untrusted-clear.test.ts` 盯着这条，
   * 防止将来有人为了方便往 `ToolContext` 上挂一个 `record`。
   *
   * @returns 是否真的解除了。当前没有标记时**不记事件**——无意义的审计条目就是审计噪音，
   *          而审计的价值恰恰在于每一条都值得看。
   */
  async clearUntrusted(reason?: string): Promise<boolean> {
    const ctx = this.#state.untrustedContext;
    if (ctx === undefined) return false;

    await this.record({
      type: 'trust.cleared',
      payload: {
        by: 'user',
        cleared: {
          callId: ctx.callId,
          toolName: ctx.toolName,
          viaCapability: ctx.viaCapability,
          since: ctx.since,
        },
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.close();
  }

  /** 供诊断：把当前会话的事件重新读一遍。**不是**状态的来源，状态在 `#state` */
  read(): AsyncIterable<PersistedEvent> {
    return this.#store.read(this.sessionId);
  }
}
