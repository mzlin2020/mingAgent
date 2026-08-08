import type { CallId, ContentBlock, SessionId, StopReason, TurnId, XmEvent } from '@xm/contracts';

/**
 * L0 Trace 派生（ADR-0032 #4，落实 docs/07 §3.1 明写的"M1 地基，必须先有"）。
 *
 * ── 为什么是"派生"，不是"记录" ──
 *
 * docs/07 原文把 trace 描述成"每次 Turn 落盘一份完整可回放的记录"，读起来像是
 * 要新起一条独立的写入路径（专门的 trace 表/文件）。**这里刻意不那么做**——
 * 一次 turn 需要的全部信息（何时开始/结束、跑了哪些工具、花了多少钱、有没有
 * 被打断、有几次权限被拒）已经完整地躺在既有的持久事件流里，新起一条写入路径
 * 只会制造 ADR-0015/0021 反复强调要防的"第二份事实来源"——万一两条路径的口径
 * 不一致（比如一条记了 costUsd 另一条没记），没人知道该信哪个。
 *
 * 所以 `deriveTraces()` 是一个**纯函数**：输入一段事件（通常是一个会话的全部
 * 持久事件），输出一组 `Trace`。它是内核里第 N 个"从事件流投影出只读视图"的
 * 例子，与 `reduce()`、`buildSummary()` 同一个形状——**trace 本身是可以随时
 * 从事件流重新算出来的派生数据，不是需要单独备份的东西**。
 *
 * ── 为什么按 turn 切分 ──
 *
 * `turn.start` → `turn.end`（或者会话结束时仍未配对的 `turn.start`，见下）
 * 天然是 docs/07 说的"一次运行"的边界——一次用户输入触发的一整段模型+工具
 * 交互。`traceId` 直接用 `turnId`：它已经是这段交互唯一的、事件流原生的标识，
 * 不需要另起一个 id 生成器。
 *
 * ── 可回放性从哪来 ──
 *
 * `steps` 里的每一步都带着 `input`/`ok`/`ms`，`outcome` 带着 `stopReason`/
 * `costUsd`——这些字段全部来自持久事件（`ScriptedProvider`/录制的 SSE fixture
 * 跑出来的历史会话，重放时会产出完全相同的事件流，因此也会派生出完全相同的
 * `Trace`）。docs/07 L0 达成的验收标准"任意一次历史运行可完整回放，产出相同的
 * 执行路径"，`deriveTraces` 是这条验收在数据层面的落点。
 */

export interface TraceStep {
  readonly kind: 'tool';
  readonly callId: CallId;
  readonly name: string;
  /** 已过启发式脱敏（同 `tool.start` 事件本身），不是引用 */
  readonly input: unknown;
  readonly ok: boolean;
  readonly ms: number;
}

export interface TraceModel {
  readonly provider: string;
  readonly model: string;
}

export interface TraceOutcome {
  /**
   * 正常结束时是 `turn.end.reason`；被打断（`message.interrupted`）但会话还没有
   * 落 `turn.end` 之前，记 `'interrupted'`；会话在 turn 中途结束事件流（比如
   * 应用崩溃、当前只读到这里）而两者都没有，记 `'unknown'`——**不猜**，
   * 猜出来的停止原因会污染将来的评测集分类（docs/07 §3.2 的判定依据）。
   */
  readonly stopReason: StopReason | 'interrupted' | 'unknown';
  /** 本 turn 内全部 `usage.recorded` 的 `costUsd` 求和；没有任何一条则为 0 */
  readonly costUsd: number;
  /** `turn.end.ts - turn.start.ts`；turn 还没有 `turn.end` 时为 `undefined` */
  readonly wallMs: number | undefined;
}

export interface TraceFeedback {
  /** 本 turn 内是否出现过至少一条 `message.interrupted` */
  readonly interrupted: boolean;
  /** 本 turn 内 `permission.decision` 里 `effect === 'deny'` 的次数 */
  readonly rejectedPermissions: number;
}

export interface Trace {
  readonly traceId: TurnId;
  readonly sessionId: SessionId;
  /** `turn.start` 的 `ts` */
  readonly ts: number;
  readonly input: readonly ContentBlock[];
  /**
   * 本 turn 用的模型。取自本 turn 内第一条 `usage.recorded`——没有任何一条
   * （比如 turn 在第一次模型调用前就被打断）时为 `undefined`，不假装知道。
   */
  readonly model: TraceModel | undefined;
  readonly steps: readonly TraceStep[];
  readonly outcome: TraceOutcome;
  readonly feedback: TraceFeedback;
}

interface TurnAccumulator {
  turnId: TurnId;
  sessionId: SessionId;
  startTs: number;
  input: readonly ContentBlock[];
  model: TraceModel | undefined;
  steps: TraceStep[];
  costUsd: number;
  interrupted: boolean;
  rejectedPermissions: number;
  /** 正在跑、还没等到 `tool.end` 的调用——用于"turn 中途结束"时按已知信息兜底 */
  runningToolNames: Map<CallId, { name: string; input: unknown }>;
}

function finalize(acc: TurnAccumulator, end: { ts: number; reason: StopReason } | undefined): Trace {
  return {
    traceId: acc.turnId,
    sessionId: acc.sessionId,
    ts: acc.startTs,
    input: acc.input,
    model: acc.model,
    steps: acc.steps,
    outcome: {
      stopReason: end !== undefined ? end.reason : acc.interrupted ? 'interrupted' : 'unknown',
      costUsd: acc.costUsd,
      wallMs: end !== undefined ? end.ts - acc.startTs : undefined,
    },
    feedback: {
      interrupted: acc.interrupted,
      rejectedPermissions: acc.rejectedPermissions,
    },
  };
}

/**
 * 从一段事件（通常是 `EventStore.read(sessionId)` 读出的全部持久事件，按 seq
 * 升序）派生出一组 `Trace`，每个 `turn.start`/`turn.end` 配对一个。
 *
 * 传入的事件不要求恰好是完整会话——可以是任意连续的一段（比如只看某个 turn
 * 附近的窗口），派生结果只依赖窗口内实际出现的事件。窗口切在 turn 中途也不会
 * 抛错：未配对的 `turn.start` 会在遍历结束时兜底产出一条 `stopReason: 'unknown'`
 * 或 `'interrupted'` 的 `Trace`（见 `TraceOutcome.stopReason` 的注释）。
 */
export function deriveTraces(events: readonly XmEvent[]): readonly Trace[] {
  const traces: Trace[] = [];
  let current: TurnAccumulator | undefined;

  for (const e of events) {
    switch (e.type) {
      case 'turn.start':
        current = {
          turnId: e.payload.turnId,
          sessionId: e.sessionId,
          startTs: e.ts,
          input: e.payload.input,
          model: undefined,
          steps: [],
          costUsd: 0,
          interrupted: false,
          rejectedPermissions: 0,
          runningToolNames: new Map(),
        };
        break;

      case 'turn.end':
        if (current?.turnId === e.payload.turnId) {
          traces.push(finalize(current, { ts: e.ts, reason: e.payload.reason }));
          current = undefined;
        }
        break;

      case 'usage.recorded':
        if (current?.turnId === e.payload.turnId) {
          current.costUsd += e.payload.costUsd;
          // 只记第一次见到的 provider/model——同一 turn 中途切模型不在当前设计范围内，
          // 记第一条足以回答"这次运行主要用的是哪个模型"
          current.model ??= { provider: e.payload.provider, model: e.payload.model };
        }
        break;

      case 'tool.start':
        current?.runningToolNames.set(e.payload.callId, { name: e.payload.name, input: e.payload.input });
        break;

      case 'tool.end': {
        const started = current?.runningToolNames.get(e.payload.callId);
        if (current !== undefined && started !== undefined) {
          current.steps.push({
            kind: 'tool',
            callId: e.payload.callId,
            name: started.name,
            input: started.input,
            ok: e.payload.ok,
            ms: e.payload.durationMs,
          });
          current.runningToolNames.delete(e.payload.callId);
        }
        break;
      }

      case 'message.interrupted':
        if (current !== undefined) current.interrupted = true;
        break;

      case 'permission.decision':
        if (current !== undefined && e.payload.effect === 'deny') {
          current.rejectedPermissions += 1;
        }
        break;

      default:
        // 其余事件类型与 trace 的形状无关（消息正文、PTY 输出等），不需要处理。
        // 这里不做穷尽性检查——trace 是可选的观测投影，不是 reduce() 那种
        // "漏一种就编译不过"的核心不变量，新增事件类型不该被这个文件卡住。
        break;
    }
  }

  // 窗口结束时仍有未配对的 turn.start —— 如实产出一条不完整的 trace，不丢弃
  if (current !== undefined) traces.push(finalize(current, undefined));

  return traces;
}
