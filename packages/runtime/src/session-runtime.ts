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
