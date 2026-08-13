import { z } from 'zod';
import type {
  AgentId,
  CallId,
  ResultBlock,
  SessionId,
  StopReason,
  ToolProgress,
} from '@xm/contracts';
import { newAgentId, newSessionId } from '@xm/contracts';
import type {
  AbortLike,
  EventStore,
  ModelProvider,
  RegisteredTool,
  SessionState,
  ToolGateway,
} from '@xm/kernel';
import { ToolInputError, ToolRegistry, defineTool, emptySessionState, reduce } from '@xm/kernel';
import type { EventBus } from './event-bus.js';
import { SessionRuntime } from './session-runtime.js';
import { runTurn, textInput } from './turn.js';
import type { TurnDeps } from './turn-types.js';

export const SUBAGENT_EXPLORE = 'agent.explore';
const MAX_SUMMARY_CHARS = 16_000;
const READ_ONLY_TOOL_NAMES = new Set([
  'fs.list',
  'fs.read',
  'search.text',
  'search.symbol',
  'search.indexed',
  'web.fetch',
  'git.status',
  'git.diff',
]);

const Input = z.strictObject({
  purpose: z.string().min(1).max(2_000).describe('要独立调查的问题，以及期望返回的结论'),
  maxTurns: z.number().int().min(1).max(8).default(4).describe('最多模型往返次数，1-8'),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
});

export type SubagentEndReason = 'completed' | 'failed' | 'aborted' | 'timeout' | 'interrupted';

export interface SubagentExploreRequest {
  readonly sessionId: SessionId;
  readonly parentCallId: CallId;
  readonly purpose: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly signal: AbortLike;
}

export interface SubagentOutcome {
  readonly agentId: AgentId;
  readonly childSessionId: SessionId;
  readonly ok: boolean;
  readonly reason: SubagentEndReason;
  readonly summary: readonly ResultBlock[];
}

export type SubagentExplorer = (request: SubagentExploreRequest) => Promise<SubagentOutcome>;

/** 主模型唯一可见的派生入口；真正访问能力由子工具逐次判定。 */
export const subagentExploreTool = (explore: SubagentExplorer): RegisteredTool =>
  defineTool({
    name: SUBAGENT_EXPLORE,
    group: 'agent',
    description:
      '派生一个隔离、串行、有限轮数的只读探索子 Agent。只回传最终结论；不能编辑、提交、运行 shell 或再次派生。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: [],
    concurrency: 'exclusive',
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (ctx.callId === undefined) {
        throw new ToolInputError(SUBAGENT_EXPLORE, '缺少当前 callId，无法关联父子生命周期。');
      }
      yield { kind: 'progress', message: '只读子 Agent 正在探索…' };
      const outcome = await explore({
        sessionId: ctx.sessionId,
        parentCallId: ctx.callId,
        purpose: input.purpose,
        maxTurns: input.maxTurns,
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
      });
      yield { kind: 'result', forModel: [...outcome.summary] };
    },
  });

export interface RunSubagentDeps {
  readonly parentRuntime: SessionRuntime;
  readonly store: EventStore;
  readonly bus: EventBus;
  readonly parentTools: ToolRegistry;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly layers: TurnDeps['layers'];
  readonly toolAvailability?: TurnDeps['toolAvailability'];
  readonly hostOs?: TurnDeps['hostOs'];
  readonly gateway?: ToolGateway;
  readonly blobs?: TurnDeps['blobs'];
  readonly prices?: TurnDeps['prices'];
  readonly pathCaseInsensitive?: boolean;
}

/** 真实派生链路：独立 SessionRuntime、只读注册表、有界取消与 finally 收尾。 */
export async function runSubagentExploration(
  deps: RunSubagentDeps,
  request: Omit<SubagentExploreRequest, 'sessionId'>,
): Promise<SubagentOutcome> {
  if (deps.parentRuntime.state.runningSubagents.size > 0) {
    throw new Error('M2 只允许串行派生：当前父会话已有一个子 Agent 在运行。');
  }

  const agentId = newAgentId();
  const childSessionId = newSessionId();
  const parentTurnId = deps.parentRuntime.state.activeTurn?.turnId;
  await deps.parentRuntime.record({
    type: 'subagent.start',
    payload: { agentId, childSessionId, callId: request.parentCallId, purpose: request.purpose },
    ...(parentTurnId === undefined ? {} : { turnId: parentTurnId }),
  });

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => {
    controller.abort();
  };
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener('abort', abortFromParent);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  let child: SessionRuntime | undefined;
  let ok = false;
  let reason: SubagentEndReason = 'failed';
  let summary: readonly ResultBlock[] = [{ type: 'text', text: '子 Agent 未能启动。' }];
  let childState: SessionState | undefined;

  try {
    child = await SessionRuntime.open({ sessionId: childSessionId, store: deps.store, bus: deps.bus });
    await child.record({
      type: 'session.created',
      payload: {
        cwd: deps.parentRuntime.state.cwd,
        modelRef: `${deps.provider.id}/${deps.model}`,
        title: `子 Agent：${request.purpose.slice(0, 80)}`,
        parentSessionId: deps.parentRuntime.sessionId,
        parentCallId: request.parentCallId,
      },
    });

    const stop = await runTurn(
      {
        runtime: child,
        provider: deps.provider,
        tools: readonlySubagentTools(deps.parentTools),
        layers: deps.layers,
        model: deps.model,
        maxIterations: request.maxTurns,
        signal: controller.signal,
        ...(deps.toolAvailability === undefined ? {} : { toolAvailability: deps.toolAvailability }),
        ...(deps.hostOs === undefined ? {} : { hostOs: deps.hostOs }),
        ...(deps.gateway === undefined ? {} : { gateway: deps.gateway }),
        ...(deps.blobs === undefined ? {} : { blobs: deps.blobs }),
        ...(deps.prices === undefined ? {} : { prices: deps.prices }),
        ...(deps.pathCaseInsensitive === undefined
          ? {}
          : { pathCaseInsensitive: deps.pathCaseInsensitive }),
      },
      textInput(
        `只做只读探索并返回简洁结论。不要尝试编辑、提交、运行 shell 或派生其它 Agent。\n\n任务：${request.purpose}`,
      ),
    );
    childState = child.state;
    reason = endReason(stop, timedOut, request.signal.aborted);
    ok = reason === 'completed';
    summary = conclusionOf(child.state, reason);
  } catch (error) {
    childState = child?.state;
    reason = failureReason(timedOut, request.signal);
    summary = [{ type: 'text', text: bounded(`子 Agent ${reason}：${errorText(error)}`) }];
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortFromParent);
    if (child !== undefined) await child.close();
    await deps.parentRuntime.record({
      type: 'subagent.end',
      payload: {
        agentId,
        ok,
        reason,
        summary: [...summary],
        ...(childState?.untrustedContext === undefined
          ? {}
          : { untrustedContext: childState.untrustedContext }),
      },
      ...(parentTurnId === undefined ? {} : { turnId: parentTurnId }),
    });
  }

  return { agentId, childSessionId, ok, reason, summary };
}

/** 应用重启后把父状态里未闭合的派生补成 interrupted，并保留子污点。 */
export async function recoverInterruptedSubagents(
  parent: SessionRuntime,
  store: EventStore,
): Promise<number> {
  let recovered = 0;
  for (const running of [...parent.state.runningSubagents.values()]) {
    const childState = await replayState(store, running.childSessionId);
    const summary = conclusionOf(childState, 'interrupted');
    await parent.record({
      type: 'subagent.end',
      payload: {
        agentId: running.agentId,
        ok: false,
        reason: 'interrupted',
        summary: [...summary],
        ...(childState.untrustedContext === undefined
          ? {}
          : { untrustedContext: childState.untrustedContext }),
      },
    });
    recovered += 1;
  }
  return recovered;
}

export function readonlySubagentTools(parent: ToolRegistry): ToolRegistry {
  const child = new ToolRegistry();
  for (const name of READ_ONLY_TOOL_NAMES) {
    const tool = parent.get(name);
    if (tool?.descriptor.source.kind === 'builtin') child.register(tool);
  }
  return child;
}

async function replayState(store: EventStore, sessionId: SessionId): Promise<SessionState> {
  let state = emptySessionState(sessionId);
  for await (const event of store.read(sessionId)) state = reduce(state, event);
  return state;
}

function endReason(stop: StopReason, timedOut: boolean, parentAborted: boolean): SubagentEndReason {
  if (timedOut) return 'timeout';
  if (parentAborted || stop === 'aborted') return 'aborted';
  return stop === 'end_turn' ? 'completed' : 'failed';
}

function failureReason(timedOut: boolean, signal: AbortLike): SubagentEndReason {
  if (timedOut) return 'timeout';
  return signal.aborted ? 'aborted' : 'failed';
}

function conclusionOf(state: SessionState, reason: SubagentEndReason): readonly ResultBlock[] {
  const assistant = [...state.messages].reverse().find((message) => message.role === 'assistant');
  const text = assistant?.blocks
    .filter((block): block is Extract<(typeof assistant.blocks)[number], { type: 'text' }> =>
      block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (text !== undefined && text !== '') return [{ type: 'text', text: bounded(text) }];
  const detail = state.lastError?.message;
  return [
    {
      type: 'text',
      text: bounded(
        reason === 'completed'
          ? '子 Agent 已结束，但没有返回文字结论。'
          : `子 Agent ${reason}${detail === undefined ? '。' : `：${detail}`}`,
      ),
    },
  ];
}

const bounded = (text: string): string => text.slice(0, MAX_SUMMARY_CHARS);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
