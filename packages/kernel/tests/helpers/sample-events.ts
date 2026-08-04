import type { XmEvent, XmEventType } from '@xm/contracts';
import {
  ALL_EVENT_TYPES,
  EMPTY_USAGE,
  XmEvent as XmEventSchema,
  newAgentId,
  newCallId,
  newCheckpointId,
  newEventId,
  newMessageId,
  newRequestId,
  newSessionId,
  newTurnId,
} from '@xm/contracts';

/**
 * 每个事件类型一条样本。
 *
 * 存在的理由：`reduce` 的穷尽性是**编译期**保证的，但"每个类型的 payload schema
 * 真的能构造出合法实例"是运行期的事——两者都需要。这份样本同时也是新 fixture 的种子。
 *
 * 新增事件类型时这里会因为缺项而失败，这是设计如此。
 */
export function sampleEvents(): XmEvent[] {
  const sessionId = newSessionId();
  const turnId = newTurnId();
  const messageId = newMessageId();
  const callId = newCallId();
  const requestId = newRequestId();
  const agentId = newAgentId();
  const checkpointId = newCheckpointId();
  const blob = {
    hash: 'a'.repeat(64),
    mime: 'text/plain',
    size: 10,
  };

  let seq = 0;
  const rows: { type: XmEventType; payload: unknown }[] = [
    { type: 'session.created', payload: { cwd: '/w', modelRef: 'anthropic/x' } },
    { type: 'session.title', payload: { title: '标题' } },
    { type: 'session.config', payload: { patch: { logging: { level: 'debug' } } } },
    { type: 'turn.start', payload: { turnId, input: [{ type: 'text', text: '你好' }] } },
    { type: 'message.start', payload: { messageId, role: 'assistant' } },
    {
      type: 'message.delta',
      payload: { messageId, blockIndex: 0, kind: 'text', text: '增量' },
    },
    {
      type: 'message.end',
      payload: {
        message: { id: messageId, role: 'assistant', ts: 1, blocks: [{ type: 'text', text: '好' }] },
      },
    },
    { type: 'message.interrupted', payload: { messageId, reason: 'aborted' } },
    {
      type: 'tool.start',
      payload: {
        callId,
        messageId,
        name: 'fs.read',
        input: { path: 'a' },
        risk: 'safe',
        capabilities: ['fs.read'],
      },
    },
    { type: 'tool.progress', payload: { callId, message: '进行中' } },
    {
      type: 'tool.end',
      payload: {
        callId,
        ok: true,
        durationMs: 5,
        forModel: [{ type: 'text', text: '结果' }],
      },
    },
    {
      type: 'permission.request',
      payload: {
        requestId,
        capability: 'fs.write',
        target: '/w/a.ts',
        risk: 'medium',
        reason: '需要写文件',
        trustLevel: 'model',
      },
    },
    {
      type: 'permission.decision',
      payload: { requestId, effect: 'allow', scope: 'once', by: 'user' },
    },
    {
      type: 'todo.updated',
      payload: { todos: [{ id: '1', content: '做事', status: 'pending' }] },
    },
    {
      type: 'subagent.start',
      payload: { agentId, childSessionId: newSessionId(), callId, purpose: '调研' },
    },
    {
      type: 'subagent.end',
      payload: { agentId, ok: true, summary: [{ type: 'text', text: '结论' }] },
    },
    {
      type: 'context.compacted',
      payload: { fromSeq: 1, toSeq: 5, summaryRef: blob, tokensBefore: 100, tokensAfter: 20 },
    },
    {
      type: 'usage.recorded',
      payload: {
        turnId,
        provider: 'anthropic',
        model: 'x',
        usage: EMPTY_USAGE,
        costUsd: 0.01,
      },
    },
    {
      type: 'checkpoint.created',
      payload: { checkpointId, kind: 'git', ref: 'abc', label: '执行前' },
    },
    { type: 'checkpoint.restored', payload: { checkpointId } },
    { type: 'notice.posted', payload: { level: 'info', code: 'c', message: 'm' } },
    {
      type: 'error.raised',
      payload: {
        error: { code: 'internal', message: '出错了', retryable: false },
        fatal: false,
      },
    },
    { type: 'turn.end', payload: { turnId, reason: 'end_turn' } },
  ];

  const covered = new Set(rows.map((r) => r.type));
  const missing = ALL_EVENT_TYPES.filter((t) => !covered.has(t));
  if (missing.length > 0) {
    throw new Error(`sample-events 缺少这些事件类型的样本：${missing.join(', ')}`);
  }

  return rows.map((r) =>
    XmEventSchema.parse({
      id: newEventId(),
      sessionId,
      // 瞬态事件不占 seq 空间（见 kernel/state/reduce.ts）
      seq: r.type === 'message.delta' || r.type === 'tool.progress' ? Math.max(seq, 1) : ++seq,
      ts: 1_754_300_000_000 + seq,
      turnId,
      type: r.type,
      v: 1,
      payload: r.payload,
    }),
  );
}
