import type {
  ContextInjectionSource,
  ContentBlock,
  ResultBlock,
  StopReason,
} from '@xm/contracts';
import type { UntrustedContext } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

export type InboxKind = 'followup' | 'steer';

export interface PendingInboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  readonly content: readonly ContentBlock[];
}

export interface AgentDispatch {
  readonly awakened: boolean;
  readonly item: PendingInboxItem;
  readonly completion: Promise<StopReason>;
}

export interface AgentDriveContext {
  readonly inbox: AgentInbox;
  readonly signal: AbortSignal;
}

export interface AgentOptions {
  readonly runtime: SessionRuntime;
  readonly drive: (
    input: readonly ContentBlock[],
    context: AgentDriveContext,
  ) => Promise<StopReason>;
  readonly onActive?: (controller: AbortController) => void;
  readonly onIdle?: (controller: AbortController) => void;
}

/** 易失队列：只有被认领并进入 turn.start 的输入才成为持久历史。 */
export class AgentInbox {
  readonly #followups: PendingInboxItem[] = [];
  readonly #steers: PendingInboxItem[] = [];
  #counter = 0;

  enqueue(kind: InboxKind, content: readonly ContentBlock[]): PendingInboxItem {
    const item = { id: `inbox-${String(++this.#counter)}`, kind, content: [...content] };
    (kind === 'steer' ? this.#steers : this.#followups).push(item);
    return item;
  }

  hasSteer(): boolean {
    return this.#steers.length > 0;
  }

  claim(): readonly PendingInboxItem[] {
    const queue = this.#steers.length > 0 ? this.#steers : this.#followups;
    return queue.splice(0, queue.length);
  }

  snapshot(): readonly PendingInboxItem[] {
    return [...this.#steers, ...this.#followups];
  }

  /** 用户点停止时清空易失队列，见 Agent.interrupt()。 */
  clear(): void {
    this.#steers.length = 0;
    this.#followups.length = 0;
  }
}

export class Agent {
  readonly #options: AgentOptions;
  readonly #inbox = new AgentInbox();
  #active: Promise<StopReason> | undefined;
  #controller: AbortController | undefined;

  constructor(options: AgentOptions) {
    this.#options = options;
  }

  get idle(): boolean {
    return this.#active === undefined;
  }

  pending(): readonly PendingInboxItem[] {
    return this.#inbox.snapshot();
  }

  followup(content: readonly ContentBlock[]): AgentDispatch {
    return this.#enqueue('followup', content);
  }

  steer(content: readonly ContentBlock[]): AgentDispatch {
    return this.#enqueue('steer', content);
  }

  async inject(input: {
    readonly content: readonly ResultBlock[];
    readonly source: ContextInjectionSource;
    readonly untrustedContext?: UntrustedContext;
  }): Promise<void> {
    await this.#options.runtime.record({
      type: 'context.injected',
      payload: {
        content: [...input.content],
        source: input.source,
        ...(input.untrustedContext === undefined
          ? {}
          : {
              untrustedContext: {
                callId: input.untrustedContext.callId,
                toolName: input.untrustedContext.toolName,
                viaCapability: input.untrustedContext.viaCapability,
                since: input.untrustedContext.since,
              },
            }),
      },
    });
    // 刻意不调用 #activate：inject 只改变下一次已被唤醒请求的历史，不唤醒空闲 Agent。
  }

  /**
   * 停止 = 中止在跑的那一步 **且** 丢掉还没被认领的排队输入。
   *
   * 只 abort 不清队列会留下一个用户看得见的怪事：点了停止，队列里那两条消息还躺着，
   * 下一次发消息时它们被一起认领发出去——用户会认为"我明明停过了"。ADR-0064 已经把未认领
   * 输入定成易失（at-most-once），停止是它最正当的一个丢弃时机。
   */
  interrupt(): boolean {
    this.#inbox.clear();
    if (this.#controller === undefined) return false;
    this.#controller.abort();
    return true;
  }

  #enqueue(kind: InboxKind, content: readonly ContentBlock[]): AgentDispatch {
    const item = this.#inbox.enqueue(kind, content);
    const awakened = this.#active === undefined;
    if (awakened) this.#activate();
    const completion = this.#active;
    if (completion === undefined) throw new Error('Agent 激活后没有运行 Promise。');
    return { awakened, item, completion };
  }

  #activate(): void {
    const controller = new AbortController();
    this.#controller = controller;
    this.#options.onActive?.(controller);
    const active = this.#drain(controller).finally(() => {
      if (this.#active !== active) return;
      this.#active = undefined;
      this.#controller = undefined;
      this.#options.onIdle?.(controller);
    });
    this.#active = active;
  }

  async #drain(controller: AbortController): Promise<StopReason> {
    let reason: StopReason = 'end_turn';
    while (!controller.signal.aborted) {
      const batch = this.#inbox.claim();
      if (batch.length === 0) break;
      const input = batch.flatMap((item) => item.content);
      reason = await this.#options.drive(input, { inbox: this.#inbox, signal: controller.signal });
    }
    return controller.signal.aborted ? 'aborted' : reason;
  }
}
