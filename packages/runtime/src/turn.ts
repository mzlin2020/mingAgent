import type {
  CallId,
  ContentBlock,
  Message,
  MessageId,
  ModelRequest,
  PermissionRequest,
  PermissionTier,
  PolicyRuleSet,
  ResultBlock,
  StopReason,
  TurnId,
} from '@xm/contracts';
import { newMessageId, newRequestId, newTurnId, xmError } from '@xm/contracts';
import type { AbortLike, ModelProvider, RegisteredTool, ToolRegistry } from '@xm/kernel';
import { ToolInputError, evaluate } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

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

export interface TurnDeps {
  readonly runtime: SessionRuntime;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly rules: PolicyRuleSet;
  readonly tier: PermissionTier;
  readonly model: string;
  readonly signal?: AbortLike;
  /** Windows 必须为 true，否则改个大小写就绕过红线（见 PolicyEngine 注释） */
  readonly pathCaseInsensitive?: boolean;
  /**
   * `ask` 的应答者。headless 下由调用方注入（冒烟里是一个固定答案的函数），
   * 桌面端是审批 UI。**不提供默认值**：默认放行等于没有闸门，默认拒绝会让人以为闸门坏了。
   */
  readonly decide?: (request: PermissionRequest) => Promise<'allow' | 'deny'>;
  /** 从工具入参提取权限目标。不同工具的 target 语义不同，交给装配方（docs/09 C4） */
  readonly targetOf?: (toolName: string, input: unknown) => string;
  /** 防跑飞。真实的停止条件是模型自己不再调工具 */
  readonly maxIterations?: number;
}

interface PendingCall {
  readonly callId: CallId;
  readonly name: string;
  argsJson: string;
}

export async function runTurn(deps: TurnDeps, userText: string): Promise<StopReason> {
  const { runtime } = deps;
  const maxIterations = deps.maxIterations ?? 8;
  const turnId = newTurnId();

  // turn.start 自己就会把用户输入并进 messages（见 reduce.ts），别在这里再补一条 user 消息
  await runtime.record({
    type: 'turn.start',
    turnId,
    payload: { turnId, input: [{ type: 'text', text: userText }] },
  });

  let reason: StopReason = 'end_turn';

  try {
    for (let i = 0; i < maxIterations; i++) {
      if (deps.signal?.aborted === true) {
        reason = 'aborted';
        break;
      }

      const { stopReason, calls } = await streamOnce(deps, turnId);
      reason = stopReason;

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
        reason = 'max_tokens';
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

  for await (const chunk of provider.stream(buildRequest(deps), signal)) {
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

      case 'usage':
        await runtime.record({
          type: 'usage.recorded',
          turnId,
          payload: {
            turnId,
            provider: provider.id,
            model: deps.model,
            usage: chunk.usage,
            // 成本由价格表算，Provider 不提供（contracts/model/usage.ts）。M0-b 没有价格表
            costUsd: 0,
          },
        });
        break;

      case 'stop':
        stopReason = chunk.reason;
        break;
    }
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

  return { stopReason, calls: order.map((id) => calls.get(id)).filter(isPending) };
}

// ── 一次工具调用 ─────────────────────────────────────────────────

async function dispatchCall(deps: TurnDeps, turnId: TurnId, call: PendingCall): Promise<void> {
  const { runtime, tools } = deps;
  const tool = tools.get(call.name);

  if (tool === undefined) {
    await failCall(deps, turnId, call, xmError('tool_not_found', `没有名为 "${call.name}" 的工具。`));
    return;
  }

  const input = parseArgs(call.argsJson);
  const target = deps.targetOf?.(call.name, input) ?? '';

  /*
   * 权限闸门。**必须在执行之前，且没有旁路。**
   *
   * 一个工具声明多个能力时逐个判定，任一被拒即整体拒绝——取最严的那个。
   * 反过来（任一放行即放行）会让"声明了 fs.read 和 fs.delete 的工具"靠 fs.read 蒙混过关。
   */
  for (const capability of tool.descriptor.capabilities) {
    const request: PermissionRequest = {
      requestId: newRequestId(),
      sessionId: runtime.sessionId,
      callId: call.callId,
      capability,
      target,
      risk: tool.descriptor.risk,
      reason: `工具 ${call.name} 需要「${capability}」`,
      trustLevel: 'model',
    };

    const verdict = evaluate({
      request,
      rules: deps.rules,
      tier: deps.tier,
      ...(deps.pathCaseInsensitive === undefined
        ? {}
        : { pathCaseInsensitive: deps.pathCaseInsensitive }),
    });

    if (verdict.effect === 'allow') continue;

    await runtime.record({
      type: 'permission.request',
      turnId,
      payload: {
        requestId: request.requestId,
        callId: call.callId,
        capability,
        target,
        risk: request.risk,
        reason: verdict.reason,
        trustLevel: 'model',
      },
    });

    if (verdict.effect === 'deny') {
      await runtime.record({
        type: 'permission.decision',
        turnId,
        payload: {
          requestId: request.requestId,
          effect: 'deny',
          scope: 'once',
          by: 'policy',
          ruleId: verdict.ruleId,
        },
      });
      await failCall(deps, turnId, call, xmError('policy_denied', verdict.reason));
      return;
    }

    // ask：交给注入的应答者。没有应答者就等同于拒绝——headless 下没人能点"允许"，
    // 默认放行会把整条闸门变成摆设
    const answer = deps.decide === undefined ? 'deny' : await deps.decide(request);
    await runtime.record({
      type: 'permission.decision',
      turnId,
      payload: { requestId: request.requestId, effect: answer, scope: 'once', by: 'user' },
    });
    if (answer === 'deny') {
      await failCall(deps, turnId, call, xmError('user_rejected', '用户拒绝了这次操作。'));
      return;
    }
  }

  await executeCall(deps, turnId, call, tool, input);
}

async function executeCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  tool: RegisteredTool,
  input: unknown,
): Promise<void> {
  const { runtime } = deps;
  const startedAt = Date.now();

  await runtime.record({
    type: 'tool.start',
    turnId,
    payload: {
      callId: call.callId,
      messageId: newMessageId(),
      name: call.name,
      input,
      risk: tool.descriptor.risk,
      capabilities: [...tool.descriptor.capabilities],
    },
  });

  const ctx = {
    sessionId: runtime.sessionId,
    signal: deps.signal ?? NEVER_ABORTS,
    cwd: runtime.state.cwd,
    executor: 'local' as const,
  };

  let forModel: ResultBlock[] = [];
  let error: ReturnType<typeof xmError> | undefined;

  try {
    for await (const progress of tool.execute(input, ctx)) {
      if (progress.kind === 'progress') {
        await runtime.record({
          type: 'tool.progress',
          turnId,
          payload: {
            callId: call.callId,
            ...(progress.message === undefined ? {} : { message: progress.message }),
            ...(progress.data === undefined ? {} : { data: progress.data }),
          },
        });
      } else {
        forModel = [...progress.forModel];
      }
    }
  } catch (e) {
    /*
     * 工具失败**不跨越主循环抛出**（contracts/base/error.ts）：转成 isError 的结果回灌，
     * 模型有机会换个方式重试。这是 Agent 能力的重要来源，也是"一次工具失败不该
     * 让整个会话死掉"的具体实现。
     */
    error =
      e instanceof ToolInputError
        ? xmError('invalid_input', e.message)
        : xmError('internal', e instanceof Error ? e.message : String(e));
    forModel = [{ type: 'text', text: error.message }];
  }

  await runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: error === undefined,
      durationMs: Date.now() - startedAt,
      forModel,
      ...(error === undefined ? {} : { error }),
    },
  });
}

/** 未执行就结束的调用：仍然要产出 tool.end，否则模型收不到这次 tool_use 的结果 */
async function failCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  error: ReturnType<typeof xmError>,
): Promise<void> {
  await deps.runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: false,
      durationMs: 0,
      forModel: [{ type: 'text', text: error.message }],
      error,
    },
  });
}

// ── 小工具 ──────────────────────────────────────────────────────

function buildRequest(deps: TurnDeps): ModelRequest {
  return {
    model: deps.model,
    // M0-b 没有 ContextBuilder：system 是空的，messages 直接取状态里的全量。
    // 预算分配、分层压缩、缓存断点都是 M2（ADR-0006），别在这里长出一个半成品。
    system: [],
    messages: [...deps.runtime.state.messages],
    tools: deps.tools.descriptors(),
    maxOutputTokens: 4096,
  };
}

/** 模型给的参数 JSON 可能是残缺的。解析不了就交给工具的 strict parse 去报 invalid_input */
function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === '') return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

const isPending = (c: PendingCall | undefined): c is PendingCall => c !== undefined;

const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export type { CallId, MessageId };
