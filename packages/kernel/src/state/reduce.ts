import type { ContentBlock, MessageId, XmEvent } from '@xm/contracts';
import { addUsage, mergeConfig, restrictSessionPatch } from '@xm/contracts';
import type { SessionState } from './session-state.js';
import { applyRestorePatch } from './checkpoint-state.js';
import { compactionOf } from './context-compaction.js';
import { taintOf } from './taint.js';
import { appendToolResult } from './tool-result.js';
import { appendInjectedMessage, appendInputMessage } from './input-message.js';

/**
 * 事件 → 状态的归约。**纯函数**：不读时间、不取随机数、不碰文件系统。
 *
 * 三条硬约束：
 *
 * 1. **必须处理全部事件类型**。`default` 分支落到 `never`，漏一种就编译不过
 *    （TS2345）。这是"新增事件类型时不会忘记更新状态"的唯一保证。
 *
 * 2. **瞬态事件必须是空操作**。message.delta / provider.status / tool.progress 不得改变状态的任何一位，
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
    case 'provider.status':
    case 'tool.progress':
    case 'shell.session.output':
    case 'ext.transient':
      return state;

    /*
     * 插件事件：**恒等**（ADR-0057 §三）。核心状态一个字段都不因插件而加，
     * 否则删掉插件就无法 reduce 历史会话——那是原则二的正面违反。
     *
     * `lastSeq` 例外，而且只能是例外：它是 seq 空间的账本，不是"状态"。不推进它，
     * 下一条事件就会拿到同一个 seq，被存储层的并发写检测器整条打回。
     * 插件要投影自己的状态，订阅事件流自建投影（炸的是它自己的面板，不是会话）。
     */
    case 'ext.persisted':
      return { ...state, lastSeq: e.seq };

    // ── 会话 ────────────────────────────────────────────────
    case 'session.created':
      return {
        ...state,
        cwd: e.payload.cwd,
        modelRef: e.payload.modelRef,
        title: e.payload.title ?? '',
        lastSeq: e.seq,
      };

    case 'session.renamed':
      return { ...state, title: e.payload.title, lastSeq: e.seq };

    case 'session.configured':
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
        messages: appendInputMessage(
          state.messages,
          e.id as unknown as MessageId,
          e.payload.input,
          e.ts,
        ),
        /*
         * 新一轮开始，清掉上一轮留下的错误。
         *
         * `lastError` 此前只写不读、也从没被清过——UI 里没有任何代码渲染它
         * （bug 报告的次要问题），补上渲染的同时发现：不清的话，一次失败之后
         * 哪怕后面一百轮都成功，错误条会一直挂在界面上，用户分不清是"这次也错了"
         * 还是"三轮前错的，没人收起来"。新一轮的用户输入本身就是"要重试"的信号。
         */
        lastError: undefined,
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
        messageId: e.payload.messageId,
        input: e.payload.input,
      });
      return {
        ...state,
        runningCalls: running,
        untrustedContext: taintOf(state, e),
        lastSeq: e.seq,
      };
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
      const presentation = e.payload.presentation; // 展示事实按 callId 收进索引（ADR-0058）
      return {
        ...state,
        runningCalls: running,
        ...(presentation === undefined
          ? {}
          : { presentations: new Map(state.presentations).set(e.payload.callId, presentation) }),
        messages: appendToolResult(state.messages, block, e.id as unknown as MessageId, e.ts),
        lastSeq: e.seq,
      };
    }

    // ── PTY 会话（ADR-0031）─────────────────────────────────
    case 'shell.session.opened': {
      const sessions = new Map(state.ptySessions);
      sessions.set(e.payload.ptySessionId, {
        ptySessionId: e.payload.ptySessionId,
        cwd: e.payload.cwd,
        startedAt: e.ts,
      });
      return { ...state, ptySessions: sessions, lastSeq: e.seq };
    }

    case 'shell.session.command.started':
    case 'shell.session.command.finished':
      return { ...state, lastSeq: e.seq };

    case 'shell.session.closed': {
      const sessions = new Map(state.ptySessions);
      sessions.delete(e.payload.ptySessionId);
      return { ...state, ptySessions: sessions, lastSeq: e.seq };
    }

    /*
     * ── 权限：只推进 seq，**不派生任何状态**（ADR-0039）──
     *
     * 这两条事件现在只在一种情况下出现：判定拒绝了一次调用，成对记下
     * request + decision（`by: 'policy'`, `effect: 'deny'`）作为审计依据。
     * 拒绝的后果由紧随其后的 `tool.error` 表达，会话状态不需要为此变化。
     *
     * 它们曾经驱动 `status: 'waiting_permission'` + `pendingPermission`（那张确认卡片）
     * 与 `grants`（"本会话都允许"）。三样东西都随审批一起删了，但**事件保留**：
     * 老会话的事件流里还有它们，`reduce()` 必须仍然认得（ADR-0008 的向后兼容），
     * 只是不再从中派生状态——把老事件解释成新状态会得到一个当时并不存在的会话。
     */
    case 'permission.request':
    case 'permission.decision':
      return { ...state, lastSeq: e.seq };

    /*
     * 用户显式解除不可信标记。
     *
     * **解除的作用域是"到下一次引入不可信内容为止"，不是整个会话永久解除。**
     * 这里不需要为此加任何机制：置回 undefined 之后，下一次带 `net.fetch` /
     * `browser.control` / `gui.capture` 的 `tool.start` 会被 `taintOf()` 重新标上。
     *
     * 永久解除是个很容易顺手写出来的实现（加一个 `everCleared` 标志就行），
     * 而它的后果是：用户为了推一次代码解除了一次，此后这个会话读多少网页都不再有防御——
     * 恰恰是长会话、读过很多外部内容的那种会话，风险最高的那种。
     */
    case 'trust.cleared':
      return { ...state, untrustedContext: undefined, lastSeq: e.seq };

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
      return {
        ...state,
        runningSubagents: subs,
        // 父已有污点时保留更早来源；否则原样接收子会话末态（ADR-0033）。
        untrustedContext: state.untrustedContext ?? e.payload.untrustedContext,
        lastSeq: e.seq,
      };
    }

    // ── 上下文与运维 ──────────────────────────────────────────
    case 'context.injected':
      return {
        ...state,
        messages: appendInjectedMessage(state.messages, e.id as unknown as MessageId, e.payload.content, e.ts),
        untrustedContext: state.untrustedContext ?? e.payload.untrustedContext,
        lastSeq: e.seq,
      };

    case 'context.compacted':
      // 只记录标记。摘要在 blob 里，reduce 读不到 I/O——真正把旧消息换成摘要是 ContextBuilder 的事。
      return {
        ...state,
        compactions: [
          ...state.compactions,
          compactionOf(e.payload),
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
          // `priced` 缺省按"已计价"读：M0 期的历史事件没有这个字段，而那时确实全是
          // 脚本化的 0 成本回合。把它们记成"未计价"会在 UI 上凭空长出一堆问号。
          unpricedTurns: state.usage.unpricedTurns + (e.payload.priced === false ? 1 : 0),
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
            manifestRef: e.payload.manifestRef,
            callId: e.payload.callId,
            restoreStartedAt: undefined,
            restoreFailure: undefined,
            restoredAt: undefined,
          },
        ],
        lastSeq: e.seq,
      };

    case 'edit.proposed':
      return {
        ...state,
        editProposals: [
          ...state.editProposals.filter(
            (item) => item.proposal.proposalId !== e.payload.proposal.proposalId,
          ),
          {
            proposal: e.payload.proposal,
            appliedAt: undefined,
            reviewedAt: undefined,
            selectedHunkIds: undefined,
          },
        ],
        lastSeq: e.seq,
      };

    case 'edit.reviewed':
      return {
        ...state,
        editProposals: state.editProposals.map((item) =>
          item.proposal.proposalId === e.payload.proposalId
            ? { ...item, reviewedAt: e.ts, selectedHunkIds: e.payload.selectedHunkIds }
            : item,
        ),
        lastSeq: e.seq,
      };

    case 'edit.applied':
      return {
        ...state,
        editProposals: state.editProposals.map((item) =>
          item.proposal.proposalId === e.payload.proposalId ? { ...item, appliedAt: e.ts } : item,
        ),
        lastSeq: e.seq,
      };

    case 'checkpoint.restore.started':
      return applyRestorePatch(state, e.payload.checkpointId, e.seq, {
        restoreStartedAt: e.ts,
        restoreFailure: undefined,
      });

    case 'checkpoint.restore.failed':
      return applyRestorePatch(state, e.payload.checkpointId, e.seq, {
        restoreStartedAt: undefined,
        restoreFailure: { message: e.payload.message, ts: e.ts },
      });

    case 'checkpoint.restored':
      return applyRestorePatch(state, e.payload.checkpointId, e.seq, {
        restoreStartedAt: undefined,
        restoreFailure: undefined,
        restoredAt: e.ts,
      });

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
