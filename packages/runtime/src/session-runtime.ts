import type {
  ContextOccupancy,
  EventOf,
  PersistedEvent,
  SessionId,
  TurnId,
  XmEvent,
  XmEventType,
} from '@xm/contracts';
import { createEvent, isPersistedType } from '@xm/contracts';
import type {
  ClockService,
  EventStore,
  IdService,
  InvariantRegistry,
  ReadOptions,
  SessionState,
  SessionWriter,
} from '@xm/kernel';
import {
  InvariantError,
  createDeterministicClock,
  createDeterministicIds,
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

/** 仅供尚未显式注入服务的旧单元测试；生产入口必须由 profile 传入 local 提供者。 */
const fallbackClock = createDeterministicClock({ start: 0 });
const fallbackIds = createDeterministicIds();

/**
 * 一个会话的运行时：**全系统唯一分配 `seq` 的地方**。
 *
 * ADR-0013 的不变量三、五、六在这里从"类型上做得到"变成"代码里只有一条路"：
 *
 *   三（seq 由调用方分配，存储只验证）—— `#lastSeq` 只在这里推进，别处拿不到它
 *   五（存储不做发布订阅）—— 广播严格排在 `append` 成功之后
 *   六（落库的事件必须已脱敏）—— 出口只有一个，那里调 `sealEvent()`
 *
 * 瞬态事件（`message.delta` / `provider.status` / `tool.progress`）走同一个出口，但**不落库、不占 seq**：
 * 它们复用上一条持久事件的 seq，只是为了让订阅者知道自己挂在哪个位置之后
 * （ADR-0008 / contracts `createEvent` 的 seq 约定）。
 */
export class SessionRuntime {
  readonly #store: EventStore;
  readonly #bus: EventBus;
  readonly #writer: SessionWriter;
  readonly sessionId: SessionId;
  readonly clock: ClockService;
  readonly ids: IdService;
  /** 运行时不变量注册表；没装就是没有这道自省闸门（ADR-0060） */
  readonly #invariants: InvariantRegistry | undefined;

  #state: SessionState;
  /**
   * 最近一次 ContextBuilder 组装完请求后的占用投影。
   * **不是** `#state` 的字段：不进快照、不进 reduce、进程退出即丢，
   * 下次组装再算一遍。渲染层经 IPC sidecar 拿到它，与卡片同一条路。
   */
  #occupancy: ContextOccupancy | undefined = undefined;
  #closed = false;
  /** 上一份快照对应的 `lastSeq`；开会话时没有快照就是 0（等同于"从没存过"）。 */
  #lastSnapshotSeq: number;
  /** 防重入闸门，见 `#maybeSnapshot()` 顶部注释 */
  #snapshotting = false;
  /**
   * 写入串行链的队尾。**永不进入 rejected 状态**（挂上去时统一 `.catch`），
   * 否则一次失败的写入会把后面排队的全部拖垮。见 `record()` 的注释。
   */
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(
    sessionId: SessionId,
    store: EventStore,
    bus: EventBus,
    writer: SessionWriter,
    state: SessionState,
    clock: ClockService,
    ids: IdService,
    lastSnapshotSeq: number,
    invariants: InvariantRegistry | undefined,
  ) {
    this.sessionId = sessionId;
    this.#store = store;
    this.#bus = bus;
    this.#writer = writer;
    this.#state = state;
    this.clock = clock;
    this.ids = ids;
    this.#lastSnapshotSeq = lastSnapshotSeq;
    this.#invariants = invariants;
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
    readonly clock?: ClockService;
    readonly ids?: IdService;
    readonly invariants?: InvariantRegistry;
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
      options.clock ?? fallbackClock,
      options.ids ?? fallbackIds,
      snapshot?.seq ?? 0,
      options.invariants,
    );
  }

  get state(): SessionState {
    return this.#state;
  }

  get lastSeq(): number {
    return this.#state.lastSeq;
  }

  get occupancy(): ContextOccupancy | undefined {
    return this.#occupancy;
  }

  /** ContextBuilder 组装完请求后写入；不是事件，不落库。 */
  noteOccupancy(value: ContextOccupancy): void {
    this.#occupancy = value;
  }

  /**
   * 记录一条事件：分配 seq → （持久事件）封存并落库 → 更新状态 → 广播。
   *
   * 顺序是**有意义的**，尤其是最后两步：广播必须在 `append` 成功之后。
   * 反过来（先广播再落库）在追加失败时会让订阅者看到一条并不存在的事件，
   * 而事件流是唯一真相——UI 上多出来一条永远回放不出来的消息，
   * 是那种用户报"它自己删了我的消息"、开发者查不出来的问题。
   *
   * ── 为什么要排队（ADR-0038 前置）──
   *
   * 真正的工作在 `#recordNow()` 里，这里只负责**把并发调用排成一队**。
   *
   * `#recordNow()` 在读 `#state.lastSeq` 与写 `#state` 之间隔着一次 `await append()`，
   * 而两个存储实现的 `append` 都是"async 声明、体内全同步"——于是让出的那一拍里，
   * 第二个写者读到的仍是陈旧的 `lastSeq`，算出**同一个 seq**，被存储的并发写检测器
   * （不变量三）整条打回 `SeqConflictError`。`record()` 是全系统唯一分配 seq 的地方，
   * 那它就必须是唯一的临界区。
   *
   * 补救只能发生在这一侧：不变量三写死了"冲突即抛，**不重试、不重新分配**"，
   * 因为冲突的含义是"有第二个写者"，静默补救会把一次事故变成一段查不清的历史。
   *
   * 这不是为自动命名新造的需求——`services.ts` 的 PTY `emit` 早就在并发写
   * `shell.session.opened`/`closed`（持久事件），撞上时被一句 `console.error` 吞掉。
   * 自动命名只是让第二个写者从偶发变成常态。
   *
   * `#tail` 上挂的链**永不进入 rejected**：一次失败只属于发起它的调用方，
   * 不该连累后面排队的写入（否则一条 `subagent.*` 闸门抛错就会毒死整个会话）。
   */
  record<T extends XmEventType>(input: {
    readonly type: T;
    readonly payload: EventOf<T>['payload'];
    readonly turnId?: TurnId;
  }): Promise<EventOf<T>> {
    if (this.#closed) return Promise.reject(new Error(`会话 ${this.sessionId} 的运行时已关闭。`));

    const run = this.#tail.then(
      () => this.#recordNow(input),
      () => this.#recordNow(input),
    );
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /**
   * `record()` 的实际工作。**只能在写入链的临界区里调**——直接调它就是把
   * 上面那道排队绕过去，seq 冲突会当场回来。
   */
  async #recordNow<T extends XmEventType>(input: {
    readonly type: T;
    readonly payload: EventOf<T>['payload'];
    readonly turnId?: TurnId;
  }): Promise<EventOf<T>> {
    const persisted = isPersistedType(input.type);
    const event = createEvent({
      id: this.ids.event(),
      type: input.type,
      sessionId: this.sessionId,
      // 瞬态事件复用上一条持久事件的 seq，不推进 seq 空间
      seq: persisted ? nextSeq(this.#state.lastSeq) : this.#state.lastSeq,
      ts: this.clock.now(),
      payload: input.payload,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });

    if (persisted) {
      await this.#writer.append([sealEvent(event as XmEvent as PersistedEvent)]);
    }

    const before = this.#state;
    this.#state = reduce(this.#state, event);
    this.#bus.publish(event);

    if (persisted) await this.#maybeSnapshot();

    /*
     * 运行时不变量（ADR-0060）。**排在广播之后**：事件已经落库、已经发出去了，
     * 这一步是"报告"不是"回滚"——不变量讲的是事件流上的关系，而那条关系已经成立或
     * 已经破了，把事件收回去只会让日志与状态对不上。抛出让调用方当场知道，
     * 而不是等三个月后有人发现某条规则从来没生效过。
     *
     * 没装注册表（生产 profile 可以不装）时这一步完全不存在，零开销。
     */
    const violations = this.#invariants?.check({ event, before, after: this.#state }) ?? [];
    if (violations.length > 0) throw new InvariantError(violations);

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
        /*
         * 走 `#recordNow` 而不是 `record`：此刻仍在写入链的临界区里（`#maybeSnapshot`
         * 由 `#recordNow` 在末尾调用，槽位还没释放），排队等自己就是永久死锁。
         */
        await this.#recordNow({
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

  /**
   * 关闭。**先关门，后排干。**
   *
   * 关门（置 `#closed`）必须在前：否则排干期间新来的 `record()` 又会挂上链尾，
   * 排不干净。排干必须在关句柄之前：已经排进链里的写入是既成事实，
   * 丢掉它等于"应用退出时静默吃掉最后一条事件"——而事件流是唯一真相。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    await this.#writer.close();
  }

  /**
   * 供诊断：把当前会话的事件重新读一遍。**不是**状态的来源，状态在 `#state`。
   *
   * `options.fromSeq` 让调用方只取增量。ContextBuilder 靠它把"每次请求全量回放"
   * 降成"只读新事件"（ADR-0048 补记）——语义不变，只是不必每次都从头读。
   */
  read(options?: ReadOptions): AsyncIterable<PersistedEvent> {
    return this.#store.read(this.sessionId, options);
  }
}
