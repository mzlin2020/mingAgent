import type { Message, ModelRequest, TurnId } from '@xm/contracts';
import type { Compaction, ModelProvider } from '@xm/kernel';
import { costOf, emptySessionState, lookupPrice, readBlob, reduce } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';
import {
  STABLE_SYSTEM_PROMPT,
  mainMaxOutputTokens,
  turnAvailabilityContext,
} from './turn-request.js';
import type { TurnDeps } from './turn-types.js';

const RECENT_RAW_TURNS = 4;
const LONG_TERM_RESERVE_RATIO = 0.05;
const COMPACTION_TRIGGER_RATIO = 0.75;
const MAX_COMPACTIONS_PER_BUILD = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SUMMARY_PROMPT = `你正在压缩一段较早的会话历史。只输出一份可供后续主模型继续工作的中文摘要。
摘要必须明确分成：未解决的问题、用户明确约束、已做出的决定、已完成工作与关键证据。
保留具体文件名、命令、错误、数值和仍有效的工具结果；不要补充原文没有的事实，不要发起工具调用。`;

interface TurnSlice {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly messages: readonly Message[];
}

interface ContextProjection {
  readonly summaries: readonly { compaction: Compaction; text: string }[];
  readonly rawMessages: readonly Message[];
  readonly compactable: readonly TurnSlice[];
  readonly recentFromSeq: number | undefined;
}

interface ContextBudget {
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
  readonly thresholdTokens: number;
  readonly hardInputTokens: number;
}

export class ContextWindowExceededError extends Error {
  readonly inputTokens: number;
  readonly hardInputTokens: number;

  constructor(
    inputTokens: number,
    hardInputTokens: number,
  ) {
    super(
      `不可压缩的近期上下文需要约 ${String(inputTokens)} tokens，超过输入预算 ` +
        `${String(hardInputTokens)}。请新建会话或缩短当前输入。`,
    );
    this.name = 'ContextWindowExceededError';
    this.inputTokens = inputTokens;
    this.hardInputTokens = hardInputTokens;
  }
}

/** 主回合 Provider 请求的唯一构建入口（ADR-0048）。 */
export class ContextBuilder {
  readonly #deps: TurnDeps;

  constructor(deps: TurnDeps) {
    this.#deps = deps;
  }

  async build(turnId: TurnId): Promise<ModelRequest> {
    const capabilities = this.#deps.provider.capabilities(this.#deps.model);
    const budget = contextBudget(capabilities.maxContext, capabilities.maxOutput);

    for (let attempt = 0; attempt < MAX_COMPACTIONS_PER_BUILD; attempt += 1) {
      const projection = await buildProjection(this.#deps.runtime, this.#deps.blobs);
      const request = assembleRequest(this.#deps, projection, budget.maxOutputTokens);
      const inputTokens = await countRequestTokens(this.#deps.provider, request);

      if (inputTokens <= budget.thresholdTokens || projection.compactable.length === 0) {
        if (inputTokens > budget.hardInputTokens) {
          throw new ContextWindowExceededError(inputTokens, budget.hardInputTokens);
        }
        return request;
      }

      const compacted = await this.#compactOldestRange(turnId, projection, budget);
      if (!compacted) {
        if (inputTokens > budget.hardInputTokens) {
          throw new ContextWindowExceededError(inputTokens, budget.hardInputTokens);
        }
        return request;
      }
    }

    throw new Error('单次上下文构建需要超过 32 个压缩区间，已停止以避免异常循环。');
  }

  async #compactOldestRange(
    turnId: TurnId,
    projection: ContextProjection,
    budget: ContextBudget,
  ): Promise<boolean> {
    const blobs = this.#deps.blobs;
    if (blobs === undefined) {
      throw new Error('上下文达到压缩阈值，但运行时没有装配 BlobStore，无法持久化摘要。');
    }

    const summaryMaxOutput = Math.max(
      1,
      Math.min(
        2_048,
        this.#deps.provider.capabilities(this.#deps.model).maxOutput,
        Math.floor(budget.maxContextTokens * 0.1),
      ),
    );
    const summaryHardInput = budget.maxContextTokens - summaryMaxOutput;
    const selected: TurnSlice[] = [];

    for (const slice of projection.compactable) {
      const candidate = [...selected, slice];
      const req = summaryRequest(this.#deps.model, candidate.flatMap((item) => item.messages), summaryMaxOutput);
      if (estimateRequestTokens(req) > summaryHardInput) break;
      selected.push(slice);
    }

    while (selected.length > 0) {
      const req = summaryRequest(
        this.#deps.model,
        selected.flatMap((item) => item.messages),
        summaryMaxOutput,
      );
      if ((await countRequestTokens(this.#deps.provider, req)) <= summaryHardInput) break;
      selected.pop();
    }
    if (selected.length === 0) return false;

    const messages = selected.flatMap((item) => item.messages);
    const tokensBefore = estimateMessagesTokens(messages);
    const summary = await generateSummary(this.#deps, turnId, messages, summaryMaxOutput);
    const tokensAfter = estimateTextTokens(summary) + 16;
    if (tokensAfter >= tokensBefore) {
      throw new Error('模型生成的摘要没有缩短所选历史，拒绝记录无效压缩。');
    }

    const summaryRef = await blobs.put(encoder.encode(summary), 'text/markdown', 'context-summary.md');
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) return false;
    await this.#deps.runtime.record({
      type: 'context.compacted',
      turnId,
      payload: {
        fromSeq: first.fromSeq,
        toSeq: last.toSeq,
        summaryRef,
        tokensBefore,
        tokensAfter,
        strategy: 'tiered-75-v1',
        provider: this.#deps.provider.id,
        model: this.#deps.model,
        maxContextTokens: budget.maxContextTokens,
        thresholdTokens: budget.thresholdTokens,
        reservedTokens: budget.reservedTokens,
        ...(projection.recentFromSeq === undefined
          ? {}
          : { recentFromSeq: projection.recentFromSeq }),
      },
    });
    return true;
  }
}

function contextBudget(maxContext: number, providerMaxOutput: number): ContextBudget {
  const maxOutputTokens = mainMaxOutputTokens({
    maxContext,
    providerMaxOutputTokens: providerMaxOutput,
  });
  const reservedTokens = Math.floor(maxContext * LONG_TERM_RESERVE_RATIO);
  const hardInputTokens = maxContext - maxOutputTokens - reservedTokens;
  const thresholdTokens = Math.max(
    1,
    Math.floor(maxContext * COMPACTION_TRIGGER_RATIO) - maxOutputTokens - reservedTokens,
  );
  if (hardInputTokens < 1) throw new Error(`模型上下文上限 ${String(maxContext)} 无法容纳主回合输入。`);
  return { maxContextTokens: maxContext, maxOutputTokens, reservedTokens, thresholdTokens, hardInputTokens };
}

function assembleRequest(
  deps: TurnDeps,
  projection: ContextProjection,
  maxOutputTokens: number,
): ModelRequest {
  const tools = deps.tools.descriptors(turnAvailabilityContext(deps));
  const todoGuidance = tools.some((tool) => tool.name === 'todo.update')
    ? '\n预计需要至少三个实质步骤时，用 todo.update 维护简短清单并随进展更新；简单任务不要创建清单。'
    : '';
  const summaryText = projection.summaries
    .map(
      ({ compaction, text }) =>
        `[历史 seq ${String(compaction.fromSeq)}-${String(compaction.toSeq)}]\n${text}`,
    )
    .join('\n\n');

  return {
    model: deps.model,
    system: [
      { text: STABLE_SYSTEM_PROMPT, cacheable: true },
      {
        text:
          `已知运行平台：${deps.hostOs ?? '当前主机'}；当前工作目录：${deps.runtime.state.cwd}。` +
          `不要重复探测这些信息。${todoGuidance}`,
        cacheable: false,
      },
      ...(summaryText === ''
        ? []
        : [{ text: `以下是已持久化的中期历史摘要：\n${summaryText}`, cacheable: false }]),
    ],
    messages: [...projection.rawMessages],
    tools,
    maxOutputTokens,
  };
}

async function buildProjection(
  runtime: SessionRuntime,
  blobs: TurnDeps['blobs'],
): Promise<ContextProjection> {
  const slices = await collectTurnSlices(runtime);
  const compactions = [...runtime.state.compactions].sort((a, b) => a.fromSeq - b.fromSeq);
  const coveredIds = new Set<string>();
  const compactedSlices = new Set<TurnSlice>();
  for (const slice of slices) {
    if (compactions.some((item) => item.fromSeq <= slice.fromSeq && item.toSeq >= slice.toSeq)) {
      compactedSlices.add(slice);
      for (const message of slice.messages) coveredIds.add(message.id);
    }
  }

  const summaries: { compaction: Compaction; text: string }[] = [];
  for (const compaction of compactions) {
    if (blobs === undefined) throw new Error('会话包含持久摘要，但运行时没有装配 BlobStore。');
    summaries.push({ compaction, text: decoder.decode(await readBlob(blobs, compaction.summaryRef)) });
  }

  const uncovered = slices.filter((slice) => !compactedSlices.has(slice));
  const recent = uncovered.slice(-RECENT_RAW_TURNS);
  return {
    summaries,
    rawMessages: runtime.state.messages.filter((message) => !coveredIds.has(message.id)),
    compactable: uncovered.slice(0, Math.max(0, uncovered.length - RECENT_RAW_TURNS)),
    recentFromSeq: recent[0]?.fromSeq,
  };
}

async function collectTurnSlices(runtime: SessionRuntime): Promise<readonly TurnSlice[]> {
  let state = emptySessionState(runtime.sessionId);
  let active: { fromSeq: number; messageIndex: number } | undefined;
  const slices: TurnSlice[] = [];

  for await (const event of runtime.read()) {
    if (event.type === 'turn.start') {
      active = { fromSeq: event.seq, messageIndex: state.messages.length };
    }
    state = reduce(state, event);
    if (event.type === 'turn.end' && active !== undefined) {
      slices.push({
        fromSeq: active.fromSeq,
        toSeq: event.seq,
        messages: state.messages.slice(active.messageIndex),
      });
      active = undefined;
    }
  }
  return slices;
}

function summaryRequest(model: string, messages: readonly Message[], maxOutputTokens: number): ModelRequest {
  return {
    model,
    system: [{ text: SUMMARY_PROMPT, cacheable: false }],
    messages: [...messages],
    toolChoice: 'none',
    maxOutputTokens,
  };
}

async function generateSummary(
  deps: TurnDeps,
  turnId: TurnId,
  messages: readonly Message[],
  maxOutputTokens: number,
): Promise<string> {
  let text = '';
  let stopReason = 'end_turn';
  for await (const chunk of deps.provider.stream(
    summaryRequest(deps.model, messages, maxOutputTokens),
    deps.signal ?? NEVER_ABORTS,
  )) {
    if (chunk.kind === 'text_delta') text += chunk.text;
    if (chunk.kind === 'tool_call_start') throw new Error('摘要模型违反 toolChoice=none 并请求了工具。');
    if (chunk.kind === 'stop') stopReason = chunk.reason;
    if (chunk.kind === 'usage') {
      const cost = costOf(chunk.usage, lookupPrice(deps.prices, deps.provider.id, deps.model));
      await deps.runtime.record({
        type: 'usage.recorded',
        turnId,
        payload: {
          turnId,
          provider: deps.provider.id,
          model: deps.model,
          usage: chunk.usage,
          costUsd: cost ?? 0,
          priced: cost !== undefined,
        },
      });
    }
  }
  if (deps.signal?.aborted === true) throw new Error('上下文摘要已取消。');
  if (stopReason !== 'end_turn') throw new Error(`上下文摘要未正常完成：${stopReason}`);
  if (text.trim() === '') throw new Error('上下文摘要模型返回了空文本。');
  return text.trim();
}

async function countRequestTokens(provider: ModelProvider, request: ModelRequest): Promise<number> {
  if (provider.countTokens !== undefined) return Math.ceil(await provider.countTokens(request));
  return estimateRequestTokens(request);
}

export function estimateRequestTokens(request: ModelRequest): number {
  return estimateTextTokens(JSON.stringify(request)) + 32;
}

function estimateMessagesTokens(messages: readonly Message[]): number {
  return estimateTextTokens(JSON.stringify(messages)) + messages.length * 8;
}

function estimateTextTokens(text: string): number {
  // UTF-8 / 3 对中文约为一字一 token，对英文比常见的 /4 更保守。
  return Math.max(1, Math.ceil(encoder.encode(text).byteLength / 3));
}

const NEVER_ABORTS = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
