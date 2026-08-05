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
import { emptySessionState, nextSeq, reduce, sealEvent } from '@xm/kernel';
import type { EventBus } from './event-bus.js';

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

  private constructor(
    sessionId: SessionId,
    store: EventStore,
    bus: EventBus,
    writer: SessionWriter,
    state: SessionState,
    now: () => number,
  ) {
    this.sessionId = sessionId;
    this.#store = store;
    this.#bus = bus;
    this.#writer = writer;
    this.#state = state;
    this.#now = now;
  }

  /**
   * 打开会话：取写句柄 → 回放事件流重建状态。
   *
   * 回放用 `for await`，一条一条过 `reduce`，全程不物化整个数组——这正是端口把
   * `read()` 定成 `AsyncIterable` 的用途，别在这里 `toArray()` 图省事。
   */
  static async open(options: {
    readonly sessionId: SessionId;
    readonly store: EventStore;
    readonly bus: EventBus;
    readonly now?: () => number;
  }): Promise<SessionRuntime> {
    const { sessionId, store, bus } = options;
    const writer = await store.openForWrite(sessionId);

    let state = emptySessionState(sessionId);
    for await (const e of store.read(sessionId)) state = reduce(state, e);

    return new SessionRuntime(sessionId, store, bus, writer, state, options.now ?? Date.now);
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
    return event;
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
