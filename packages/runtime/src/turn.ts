import type {
  CallId,
  ContentBlock,
  Message,
  MessageId,
  ModelRequest,
  StopReason,
  TurnId,
} from '@xm/contracts';
import { newMessageId, newTurnId, xmError } from '@xm/contracts';
import type { AbortLike } from '@xm/kernel';
import { costOf, lookupPrice } from '@xm/kernel';
import { ContextBuilder } from './context-builder.js';
import { dispatchCall } from './turn-tools.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

export type { PendingCall, TurnDeps } from './turn-types.js';

/**
 * 极薄的 Turn 循环（M0-b）。
 *
 * **它刻意不完整。** 没有 ContextBuilder、没有上下文压缩、没有并行调度、
 * 没有子 Agent——那些是 M1/M2。这里只做一件事：把
 * `Provider → 事件 → 权限闸门 → 工具 → 事件` 这条链子接通，让它在真实的 SQLite 上跑一遍。
 *
 * 之所以现在就要这条链子，是因为它是几个架构约束**唯一**的实测点：
 * runtime 不依赖 electron、内核纯逻辑能被装配、事件流能完整回放出状态。
 * 这些约束在 M0-a 全是纸面上的。
 *
 * 三条在这里落地的不变量：
 *   · `seq` 只由 `SessionRuntime` 分配（不变量三）
 *   · 广播排在落库之后（不变量五）
 *   · 工具**执行前**必过 PolicyEngine——闸门长在路径上，不是长在文档里
 */

/** 最常见的输入形状：纯文字。多模态输入直接构造 ContentBlock[] 传给 runTurn */
export const textInput = (text: string): ContentBlock[] => [{ type: 'text', text }];

export async function runTurn(deps: TurnDeps, input: readonly ContentBlock[]): Promise<StopReason> {
  const { runtime } = deps;

  /*
   * 能力闸门必须在这里、在记第一条事件之前判。`turn.start` 一旦落库就必须有一条
   * `turn.end` 收尾配对（ADR-0008 的包含性不变量）；如果放任图片块流到 Provider
   * 深处才失败关闭，就会留下一条只有开始没有收尾的事件流。直接 throw，不新增
   * `StopReason` 枚举值——调用方（`services.sendUserMessage`）的 try/finally
   * 接得住，异常经 IPC 信封转成 `{ok:false}` 落进渲染层已有的错误态，不需要
   * 再造一条"被拒绝"的收尾语义。
   *
   * 只查*这一轮新输入*，不审计历史消息——中途换成不支持 vision 的模型、
   * 历史里却带着图片，仍然会在 Provider 深处报错。那是 M2 ContextBuilder
   * （预算/压缩）该管的事，见 ADR-0029 遗留。
   */
  const caps = deps.provider.capabilities(deps.model);
  if (input.some((b) => b.type === 'image') && !caps.vision) {
    throw new Error(
      `模型 ${deps.model} 不支持图片输入（vision），请换一个支持的模型或去掉图片后再试。`,
    );
  }
  if (input.some((b) => b.type === 'document') && !caps.documents) {
    throw new Error(`模型 ${deps.model} 不支持文档输入，请换一个支持的模型或去掉附件后再试。`);
  }

  /*
   * 8 太容易在正常任务里撞到——一个「做个 todolist」这种朴素任务，
   * 读文件、列目录、写几步、回头检查一下，往返次数很容易过 8。
   * 撞上限的后果不是"模型偷懒"，是回合被腰斩，用户看到的是任务莫名其妙半途而废。
   * 这里的上限本来就只是"防跑飞"的兜底，不是引导模型精简步骤的手段——
   * 收敛应该来自模型自己判断任务完成，不是靠一个悄悄的步数配额逼它提前结束。
   * 调大到 9999，实质上等于交给"模型自己不再调工具"这一条真正的停止条件；
   * 真正失控的死循环由用户手动停止 / 会话预算兜底，不该指望这个数字。
   */
  const maxIterations = deps.maxIterations ?? 9999;
  const turnId = newTurnId();

  // turn.start 自己就会把用户输入并进 messages（见 reduce.ts），别在这里再补一条 user 消息
  await runtime.record({
    type: 'turn.start',
    turnId,
    payload: { turnId, input: [...input] },
  });

  return driveTurnLoop(deps, turnId, maxIterations);
}

/**
 * 续跑一个已经开始、但因为进程崩溃而没跑完的回合（M1-e 崩溃恢复，docs/04 §8 步骤 3"继续"）。
 *
 * **调用方必须先用 `synthesizeInterruption()`（`crash-recovery.ts`）补完缺失的收尾事件**，
 * 这里不做——"要不要补、补哪些"是 `OrphanedTurn` 该回答的问题，这个函数只负责"从这里
 * 继续跑"，与 `runTurn()` 写完 `turn.start` 之后要做的事完全一样：下一步就是 `streamOnce`，
 * 效果等价于"崩溃发生的那个迭代边界之后，循环本来就会做的下一步"。不重连任何原生进程、
 * 不重放原始工具调用——模型只是被如实告知"这次没跑完"，这是没有幂等性契约时唯一安全
 * 的做法。`maxIterations` 重新计满：崩溃前用了几次不落库，这是可接受的近似。
 */
export async function resumeTurn(deps: TurnDeps, turnId: TurnId): Promise<StopReason> {
  return driveTurnLoop(deps, turnId, deps.maxIterations ?? 9999);
}

async function driveTurnLoop(deps: TurnDeps, turnId: TurnId, maxIterations: number): Promise<StopReason> {
  const { runtime } = deps;
  let reason: StopReason = 'end_turn';
  let maxTokenContinuations = 0;

  try {
    for (let i = 0; i < maxIterations; i++) {
      if (deps.signal?.aborted === true) {
        reason = 'aborted';
        break;
      }

      const { stopReason, calls } = await streamOnce(deps, turnId);
      reason = stopReason;

      if (calls.length === 0 && stopReason === 'max_tokens') {
        if (maxTokenContinuations === 0) {
          maxTokenContinuations += 1;
          continue;
        }
        await runtime.record({
          type: 'notice.posted',
          turnId,
          payload: {
            level: 'warn',
            code: 'turn.max_tokens',
            message: '模型连续两次达到输出上限，任务可能尚未完成。请让小明继续，或缩小任务范围。',
          },
        });
        break;
      }

      if (calls.length === 0 || stopReason === 'aborted' || stopReason === 'error') break;

      for (const call of calls) {
        await dispatchCall(deps, turnId, call);
      }

      if (i === maxIterations - 1) {
        // 跑满上限而模型还在要工具：如实记下来，不要假装是正常结束
        await runtime.record({
          type: 'notice.posted',
          turnId,
          payload: {
            level: 'warn',
            code: 'turn.max_iterations',
            message: `本回合达到 ${String(maxIterations)} 次模型往返上限，已停止。`,
          },
        });
        reason = 'max_iterations';
      }
    }
  } finally {
    await runtime.record({ type: 'turn.end', turnId, payload: { turnId, reason } });
  }

  return reason;
}

// ── 一次模型往返 ─────────────────────────────────────────────────

interface StreamResult {
  readonly stopReason: StopReason;
  readonly calls: readonly PendingCall[];
}

async function streamOnce(deps: TurnDeps, turnId: TurnId): Promise<StreamResult> {
  const { runtime, provider } = deps;
  const messageId = newMessageId();

  let request: ModelRequest;
  try {
    request = await new ContextBuilder(deps).build(turnId);
  } catch (error) {
    const failure =
      error instanceof Error
        ? xmError('provider_error', error.message)
        : xmError('internal', String(error));
    await runtime.record({
      type: 'error.raised',
      turnId,
      payload: { error: failure, fatal: false },
    });
    return { stopReason: 'error', calls: [] };
  }

  await runtime.record({
    type: 'message.start',
    turnId,
    payload: { messageId, role: 'assistant', model: deps.model },
  });

  let text = '';
  let thinking = '';
  let thinkingSignature: string | undefined;
  let stopReason: StopReason = 'end_turn';
  const calls = new Map<CallId, PendingCall>();
  const order: CallId[] = [];

  const signal: AbortLike = deps.signal ?? NEVER_ABORTS;
  let failure: ReturnType<typeof xmError> | undefined;

  try {
    for await (const chunk of provider.stream(request, signal)) {
      switch (chunk.kind) {
        case 'text_delta':
          text += chunk.text;
          // 瞬态：不落库、不占 seq，只推给订阅者。ADR-0008 的硬不变量是它不得携带
          // message.end 里不存在的信息——这里的 text 最后逐字进了 message.end
          await runtime.record({
            type: 'message.delta',
            turnId,
            payload: { messageId, blockIndex: 0, kind: 'text', text: chunk.text },
          });
          break;

        case 'thinking_delta':
          thinking += chunk.text;
          await runtime.record({
            type: 'message.delta',
            turnId,
            payload: { messageId, blockIndex: 0, kind: 'thinking', text: chunk.text },
          });
          break;

        case 'thinking_signature':
          thinkingSignature = chunk.signature;
          break;

        case 'tool_call_start':
          calls.set(chunk.id, { callId: chunk.id, name: chunk.name, argsJson: '' });
          order.push(chunk.id);
          break;

        case 'tool_call_delta': {
          const pending = calls.get(chunk.id);
          // 各家的分片边界不同，累积完整之后再一次性 parse 是唯一稳妥做法（contracts/model/chunk.ts）
          if (pending !== undefined) pending.argsJson += chunk.argsJson;
          break;
        }

        case 'tool_call_end':
          break;

        case 'usage': {
          // 成本由价格表算，Provider 不提供（contracts/model/usage.ts）
          const cost = costOf(chunk.usage, lookupPrice(deps.prices, provider.id, deps.model));
          await runtime.record({
            type: 'usage.recorded',
            turnId,
            payload: {
              turnId,
              provider: provider.id,
              model: deps.model,
              usage: chunk.usage,
              costUsd: cost ?? 0,
              priced: cost !== undefined,
            },
          });
          break;
        }

        case 'stop':
          stopReason = chunk.reason;
          break;
      }
    }
  } catch (e) {
    /*
     * Provider 抛错**不会跨越这里**。
     *
     * 让它往外抛看起来更"干净"，但那样这一段已经推给订阅者的 `message.delta`
     * 就再也不会有对应的 `message.end`——ADR-0008 的包含性不变量当场破掉，
     * 表现是用户看着打字机打出半句话，重开会话后那半句凭空消失。
     * 所以下面照常落 message.end（带已到达的部分），错误另记一条 error.raised。
     */
    failure = e instanceof Error ? xmError('provider_error', e.message) : xmError('internal', String(e));
    const asXm = (e as { xm?: unknown }).xm;
    if (isXmErrorLike(asXm)) failure = asXm;
    stopReason = failure.code === 'aborted' ? 'aborted' : 'error';
  }

  /*
   * 兜底：Provider 没守约定（取消时抛而不是干净收尾）时也要判对。
   *
   * 端口现在明写了「取消时正常结束迭代」，两个自家适配器都守。但这道兜底不能撤——
   * M3 的 MCP、M2 的子 Agent 都会带进不受我们控制的实现，而"取消被记成失败"
   * 是一个用户当场看得见的错。
   *
   * **`failure` 必须一并清掉。** 这是一次真调用照出来的 bug：真实 fetch 在 abort 时
   * 抛 `AbortError`，上面的 catch 把它记成 `provider_error`，这里只纠正了 stopReason
   * 而没动 failure——于是用户点了停止，却收到一条红色的 `error.raised`。
   * 单元测试没抓到，因为它只断言了两条事件**存在**，从没断言 error.raised **不存在**。
   */
  if (signal.aborted) {
    stopReason = 'aborted';
    failure = undefined;
  }

  const blocks: ContentBlock[] = [];
  if (thinking !== '') {
    blocks.push({
      type: 'thinking',
      text: thinking,
      ...(thinkingSignature === undefined ? {} : { signature: thinkingSignature }),
    });
  }
  if (text !== '') blocks.push({ type: 'text', text });
  for (const id of order) {
    const c = calls.get(id);
    if (c === undefined) continue;
    blocks.push({ type: 'tool_use', id: c.callId, name: c.name, input: parseArgs(c.argsJson) });
  }

  const message: Message = {
    id: messageId,
    role: 'assistant',
    blocks,
    model: deps.model,
    ts: Date.now(),
  };
  await runtime.record({ type: 'message.end', turnId, payload: { message } });

  /*
   * 中断是**两条事件**，不是一条。
   *
   * 直觉的写法是"中断时只发 message.interrupted"，但那样已经流出去的 delta
   * 在持久流里没有任何落点（见上面 catch 里的注释）。所以顺序是：
   *   message.end        —— 已到达的部分进 messages，模型下一轮看得见自己说到哪
   *   message.interrupted —— UI 据此标注"已停止"，live buffer 据此归零（ADR-0021）
   *
   * 反过来说，只发 message.end 也不行：那样这条被截断的回复看起来和一条正常回复
   * 完全一样，用户回看历史时无从分辨。
   */
  if (stopReason === 'aborted') {
    await runtime.record({
      type: 'message.interrupted',
      turnId,
      payload: { messageId, reason: 'aborted' },
    });
  }

  if (failure !== undefined && failure.code !== 'aborted') {
    await runtime.record({
      type: 'error.raised',
      turnId,
      // 一次模型调用失败不等于会话完蛋：用户可以改配置、换模型、重试
      payload: { error: failure, fatal: false },
    });
  }

  return { stopReason, calls: order.map((id) => calls.get(id)).filter(isPending) };
}

// ── 一次工具调用 ─────────────────────────────────────────────────

// ── 小工具 ──────────────────────────────────────────────────────

/** 模型给的参数 JSON 可能是残缺的；消息事件保留一个安全的对象形状。 */
function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === '') return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

const isPending = (c: PendingCall | undefined): c is PendingCall => c !== undefined;

/**
 * Provider 抛的错里若挂着结构化 `XmError`（`ProviderHttpError.xm`），原样用它。
 *
 * 用结构判断而不是 `instanceof`：runtime 不依赖 `@xm/providers`（依赖方向是
 * apps 装配时才把两者接上），拿不到那个类。而这里要的信息只是"有没有 code"。
 */
function isXmErrorLike(v: unknown): v is ReturnType<typeof xmError> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { code?: unknown }).code === 'string' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export type { CallId, MessageId };
