import type { ContentBlock, Message, MessageId, XmEvent } from '@xm/contracts';
import { addUsage, mergeConfig, restrictSessionPatch } from '@xm/contracts';
import type { PermissionGrant, SessionState } from './session-state.js';

/**
 * 事件 → 状态的归约。**纯函数**：不读时间、不取随机数、不碰文件系统。
 *
 * 三条硬约束：
 *
 * 1. **必须处理全部事件类型**。`default` 分支落到 `never`，漏一种就编译不过
 *    （TS2345）。这是"新增事件类型时不会忘记更新状态"的唯一保证。
 *
 * 2. **瞬态事件必须是空操作**。message.delta / tool.progress 不得改变状态的任何一位，
 *    包括 `lastSeq`。这不是"还没实现"，是 ADR-0008 的硬不变量：
 *    *transient 事件不得携带 persisted 事件流中不存在的信息*。
 *    `tests/persistence-containment.test.ts` 把它变成 CI 闸门。
 *
 * 3. **`lastSeq` 只跟持久化流**。瞬态事件不落库，也就不占 seq 空间——否则
 *    `events` 表就会有空洞，"从 seq N 起增量订阅"这件事需要额外元数据才能做。
 */
export function reduce(state: SessionState, e: XmEvent): SessionState {
  switch (e.type) {
    // ── 瞬态：空操作。改这里之前先读上面第 2 条 ──────────────────
    case 'message.delta':
    case 'tool.progress':
      return state;

    // ── 会话 ────────────────────────────────────────────────
    case 'session.created':
      return {
        ...state,
        cwd: e.payload.cwd,
        modelRef: e.payload.modelRef,
        title: e.payload.title ?? '',
        lastSeq: e.seq,
      };

    case 'session.title':
      return { ...state, title: e.payload.title, lastSeq: e.seq };

    case 'session.config':
      // 会话补丁不得改权限档位与 Provider 密钥（restrictSessionPatch 的注释说明了原因）。
      // 写入侧本应先拒绝并发 notice；这里是读取侧的兜底——历史数据、被篡改的库、
      // 旧版本写入的事件都从这条路进来，而 reduce 发不了事件，只能静默丢弃。
      return {
        ...state,
        config: mergeConfig(state.config, restrictSessionPatch(e.payload.patch).patch),
        lastSeq: e.seq,
      };

    // ── 回合 ────────────────────────────────────────────────
    case 'turn.start':
      return {
        ...state,
        status: 'running',
        activeTurn: { turnId: e.payload.turnId, startedAt: e.ts },
        // 用户输入进入消息流。messageId 取事件 id：确定性且唯一，
        // reduce 不能自己生成随机 ID。
        messages: [
          ...state.messages,
          {
            id: e.id as unknown as MessageId,
            role: 'user',
            blocks: e.payload.input,
            ts: e.ts,
          },
        ],
        lastSeq: e.seq,
      };

    case 'turn.end':
      return {
        ...state,
        status: 'idle',
        activeTurn: undefined,
        // 回合结束时仍在跑的调用 = 被中断的调用（崩溃恢复要能看出来）
        runningCalls: new Map(),
        interruptedCalls: [...state.interruptedCalls, ...state.runningCalls.values()],
        lastSeq: e.seq,
      };

    // ── 模型消息 ─────────────────────────────────────────────
    case 'message.start':
      return {
        ...state,
        activeMessage: {
          messageId: e.payload.messageId,
          role: e.payload.role,
          model: e.payload.model,
          startedAt: e.ts,
        },
        lastSeq: e.seq,
      };

    case 'message.end':
      return {
        ...state,
        messages: [...state.messages, e.payload.message],
        activeMessage: undefined,
        lastSeq: e.seq,
      };

    case 'message.interrupted':
      return { ...state, activeMessage: undefined, lastSeq: e.seq };

    // ── 工具 ────────────────────────────────────────────────
    case 'tool.start': {
      const running = new Map(state.runningCalls);
      running.set(e.payload.callId, {
        callId: e.payload.callId,
        name: e.payload.name,
        startedAt: e.ts,
      });
      return { ...state, runningCalls: running, lastSeq: e.seq };
    }

    case 'tool.end': {
      const running = new Map(state.runningCalls);
      running.delete(e.payload.callId);
      const block: ContentBlock = {
        type: 'tool_result',
        toolUseId: e.payload.callId,
        content: e.payload.forModel,
        isError: !e.payload.ok,
      };
      return {
        ...state,
        runningCalls: running,
        messages: appendToolResult(state.messages, block, e.id as unknown as MessageId, e.ts),
        lastSeq: e.seq,
      };
    }

    // ── 权限 ────────────────────────────────────────────────
    case 'permission.request':
      return {
        ...state,
        status: 'waiting_permission',
        pendingPermission: {
          requestId: e.payload.requestId,
          sessionId: state.id,
          capability: e.payload.capability,
          target: e.payload.target,
          risk: e.payload.risk,
          reason: e.payload.reason,
          trustLevel: e.payload.trustLevel,
          ...(e.payload.callId === undefined ? {} : { callId: e.payload.callId }),
          ...(e.payload.preview === undefined ? {} : { preview: e.payload.preview }),
        },
        lastSeq: e.seq,
      };

    case 'permission.decision': {
      // scope=once 不留痕（它只对当前这一次调用有效）；session/always 必须进状态，
      // 否则回放出的会话看不出"用户已经授权过"——见 session-state.ts 的 grants 注释。
      const { scope, requestId, effect } = e.payload;
      const pending = state.pendingPermission;
      const grant: PermissionGrant | undefined =
        scope !== 'once' && pending?.requestId === requestId
          ? {
              requestId,
              capability: pending.capability,
              target: pending.target,
              effect,
              scope,
              ts: e.ts,
            }
          : undefined;
      return {
        ...state,
        status: state.activeTurn === undefined ? 'idle' : 'running',
        pendingPermission: undefined,
        grants: grant === undefined ? state.grants : [...state.grants, grant],
        lastSeq: e.seq,
      };
    }

    // ── 任务与子 Agent ────────────────────────────────────────
    case 'todo.updated':
      return { ...state, todos: e.payload.todos, lastSeq: e.seq };

    case 'subagent.start': {
      const subs = new Map(state.runningSubagents);
      subs.set(e.payload.agentId, {
        agentId: e.payload.agentId,
        childSessionId: e.payload.childSessionId,
        purpose: e.payload.purpose,
        startedAt: e.ts,
      });
      return { ...state, runningSubagents: subs, lastSeq: e.seq };
    }

    case 'subagent.end': {
      const subs = new Map(state.runningSubagents);
      subs.delete(e.payload.agentId);
      return { ...state, runningSubagents: subs, lastSeq: e.seq };
    }

    // ── 上下文与运维 ──────────────────────────────────────────
    case 'context.compacted':
      // 只记录标记。摘要在 blob 里，reduce 读不到 I/O——
      // 真正把旧消息换成摘要是 ContextBuilder 在装配时做的事。
      return {
        ...state,
        compactions: [
          ...state.compactions,
          {
            fromSeq: e.payload.fromSeq,
            toSeq: e.payload.toSeq,
            summaryRef: e.payload.summaryRef,
            tokensBefore: e.payload.tokensBefore,
            tokensAfter: e.payload.tokensAfter,
          },
        ],
        lastSeq: e.seq,
      };

    case 'usage.recorded':
      return {
        ...state,
        usage: {
          usage: addUsage(state.usage.usage, e.payload.usage),
          costUsd: state.usage.costUsd + e.payload.costUsd,
          turns: state.usage.turns + 1,
        },
        lastSeq: e.seq,
      };

    case 'checkpoint.created':
      return {
        ...state,
        checkpoints: [
          ...state.checkpoints,
          {
            checkpointId: e.payload.checkpointId,
            kind: e.payload.kind,
            ref: e.payload.ref,
            label: e.payload.label,
            restoredAt: undefined,
          },
        ],
        lastSeq: e.seq,
      };

    case 'checkpoint.restored':
      return {
        ...state,
        checkpoints: state.checkpoints.map((c) =>
          c.checkpointId === e.payload.checkpointId ? { ...c, restoredAt: e.ts } : c,
        ),
        lastSeq: e.seq,
      };

    case 'notice.posted':
      return {
        ...state,
        notices: [
          ...state.notices,
          {
            level: e.payload.level,
            code: e.payload.code,
            message: e.payload.message,
            ts: e.ts,
          },
        ],
        lastSeq: e.seq,
      };

    case 'error.raised':
      return {
        ...state,
        status: e.payload.fatal ? 'error' : state.status,
        lastError: e.payload.error,
        lastSeq: e.seq,
      };

    default: {
      // 漏处理任一事件类型 → 这里编译失败（TS2345）。不要用 `as never` 绕过。
      const exhaustive: never = e;
      return exhaustive;
    }
  }
}

/** 一次性把整段事件流归约完。回放、崩溃恢复、测试都走它。 */
export const reduceAll = (initial: SessionState, events: Iterable<XmEvent>): SessionState => {
  let state = initial;
  for (const e of events) state = reduce(state, e);
  return state;
};

/**
 * 工具结果要作为 `tool_result` 块进 user 消息（Anthropic 形状，见 contracts/content/message.ts）。
 *
 * 并行的多个工具调用应该合进同一条 user 消息——所以这里把结果追加到"末尾那条纯
 * tool_result 的 user 消息"上；没有就新建一条。判断是纯结构性的，因此仍然确定性。
 */
function appendToolResult(
  messages: readonly Message[],
  block: ContentBlock,
  fallbackId: MessageId,
  ts: number,
): readonly Message[] {
  const last = messages.at(-1);
  const isToolResultBucket =
    last?.role === 'user' && last.blocks.length > 0 && last.blocks.every((b) => b.type === 'tool_result');

  if (isToolResultBucket) {
    return [...messages.slice(0, -1), { ...last, blocks: [...last.blocks, block] }];
  }
  return [...messages, { id: fallbackId, role: 'user', blocks: [block], ts }];
}
