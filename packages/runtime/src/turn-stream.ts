import type {
  CallId,
  ContentBlock,
  Message,
  ModelRequest,
  StopReason,
  TurnId,
} from '@xm/contracts';
import { xmError } from '@xm/contracts';
import { costOf, lookupPrice } from '@xm/kernel';
import type { TurnExtensionHost } from './turn-extension-host.js';
import { parseToolArgs } from './turn-args.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

export interface StreamResult {
  readonly stopReason: StopReason;
  readonly calls: readonly PendingCall[];
  readonly error?: unknown;
}

export async function streamOnce(
  deps: TurnDeps,
  extensions: TurnExtensionHost,
  turnId: TurnId,
): Promise<StreamResult> {
  const { runtime } = deps;
  const messageId = runtime.ids.message();
  let request: ModelRequest;
  try {
    const prepared = await extensions.preStep({ kind: 'request', deps, turnId });
    if (prepared.kind !== 'request') throw new Error('turn/pre-step 没有产出模型请求。');
    request = await extensions.request({ deps, turnId, request: prepared.request });
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
    return { stopReason: 'error', calls: [], error };
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
  let failure: ReturnType<typeof xmError> | undefined;

  try {
    const stream = await extensions.stream({ deps, turnId, request });
    for await (const chunk of stream) {
      switch (chunk.kind) {
        case 'text_delta':
          text += chunk.text;
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
          if (pending !== undefined) pending.argsJson += chunk.argsJson;
          break;
        }
        case 'tool_call_end':
          break;
        case 'usage': {
          const cost = costOf(chunk.usage, lookupPrice(deps.prices, deps.provider.id, deps.model));
          await runtime.record({
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
          break;
        }
        case 'stop':
          stopReason = chunk.reason;
          break;
      }
    }
  } catch (error) {
    failure =
      error instanceof Error
        ? xmError('provider_error', error.message)
        : xmError('internal', String(error));
    const asXm = (error as { xm?: unknown }).xm;
    if (isXmErrorLike(asXm)) failure = asXm;
    stopReason = failure.code === 'aborted' ? 'aborted' : 'error';
  }
  if (deps.signal?.aborted === true) {
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
    const call = calls.get(id);
    if (call === undefined) continue;
    /*
     * 助手消息里那份 `input`。解不开时留 `{}` 是**协议要求**（各家 API 的 tool_use
     * 入参必须是对象，回放这条消息时要原样发回去），不是兜底：这次调用一定会在
     * `prepareCall` 的 ② 步被拒绝执行，原文与失败理由一起进 `tool.end`（C1）。
     */
    const args = parseToolArgs(call.argsJson);
    blocks.push({
      type: 'tool_use',
      id: call.callId,
      name: call.name,
      input: args.ok ? args.value : {},
    });
  }
  const message: Message = {
    id: messageId,
    role: 'assistant',
    blocks,
    model: deps.model,
    ts: runtime.clock.now(),
  };
  await runtime.record({ type: 'message.end', turnId, payload: { message } });
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
      payload: { error: failure, fatal: false },
    });
  }
  return {
    stopReason,
    calls: order.map((id) => calls.get(id)).filter(isPending),
    ...(failure === undefined ? {} : { error: failure }),
  };
}

const isPending = (call: PendingCall | undefined): call is PendingCall => call !== undefined;

function isXmErrorLike(value: unknown): value is ReturnType<typeof xmError> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
