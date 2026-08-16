import type { XmEvent, XmEventType } from '@xm/contracts';
import {
  ALL_EVENT_TYPES,
  EMPTY_USAGE,
  XmEvent as XmEventSchema,
  isPersistedType,
  newAgentId,
  newCallId,
  newCheckpointId,
  newEditProposalId,
  newEventId,
  newMessageId,
  newPtySessionId,
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
  const editProposalId = newEditProposalId();
  const ptySessionId = newPtySessionId();
  const blob = {
    hash: 'a'.repeat(64),
    mime: 'text/plain',
    size: 10,
  };

  let seq = 0;
  const rows: { type: XmEventType; payload: unknown }[] = [
    { type: 'session.created', payload: { cwd: '/w', modelRef: 'anthropic/x' } },
    { type: 'session.renamed', payload: { title: '标题' } },
    { type: 'session.configured', payload: { patch: { tools: { presentation: 'code' } } } },
    { type: 'turn.start', payload: { turnId, input: [{ type: 'text', text: '你好' }] } },
    { type: 'message.start', payload: { messageId, role: 'assistant' } },
    {
      type: 'message.delta',
      payload: { messageId, blockIndex: 0, kind: 'text', text: '增量' },
    },
    {
      type: 'provider.status',
      payload: { phase: 'retrying', attempt: 2, maxAttempts: 4, delayMs: 500, reason: '限流' },
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
      // Code Mode 的子调用（ADR-0072）。**没有 forModel 字段**——程序的中间值不进模型请求
      type: 'tool.code.dispatch',
      payload: {
        callId: newCallId(),
        parentCallId: callId,
        index: 0,
        name: 'fs.read',
        input: { path: 'b' },
        risk: 'safe',
        capabilities: ['fs.read'],
        ok: true,
        durationMs: 3,
      },
    },
    {
      type: 'shell.session.opened',
      payload: { ptySessionId, cwd: '/w', cols: 80, rows: 24 },
    },
    {
      type: 'shell.session.command.started',
      payload: { ptySessionId, argv: ['node', '--version'], cwd: '/w', timeoutMs: 1000 },
    },
    { type: 'shell.session.output', payload: { ptySessionId, chunk: '$ ' } },
    {
      type: 'shell.session.command.finished',
      payload: { ptySessionId, exitCode: 0, reason: 'exited', tail: '$ ' },
    },
    {
      type: 'shell.session.closed',
      payload: { ptySessionId, exitCode: 0, reason: 'exited', tail: '$ ' },
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
      type: 'trust.cleared',
      payload: {
        by: 'user',
        cleared: { callId, toolName: 'web.fetch', viaCapability: 'net.fetch', since: 1 },
        reason: '这几个网页是我自己的',
      },
    },
    {
      type: 'todo.updated',
      payload: { todos: [{ id: '1', content: '做事', status: 'pending' }] },
    },
    {
      type: 'edit.proposed',
      payload: {
        proposal: {
          proposalId: editProposalId,
          files: [{
            path: '/w/a.ts',
            beforeHash: 'b'.repeat(64),
            afterHash: 'c'.repeat(64),
            replacements: [{ oldText: 'old', newText: 'new', expectedMatches: 1 }],
            diff: '--- a/a.ts\n+++ b/a.ts',
          }],
        },
      },
    },
    { type: 'edit.reviewed', payload: { proposalId: editProposalId, selectedHunkIds: ['0:0'] } },
    { type: 'edit.applied', payload: { proposalId: editProposalId } },
    {
      type: 'subagent.start',
      payload: { agentId, childSessionId: newSessionId(), callId, purpose: '调研' },
    },
    {
      type: 'subagent.end',
      payload: { agentId, ok: true, summary: [{ type: 'text', text: '结论' }] },
    },
    {
      type: 'context.injected',
      payload: {
        content: [{ type: 'text', text: '后台结论' }],
        source: { kind: 'subagent', agentId },
      },
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
    { type: 'checkpoint.restore.started', payload: { checkpointId } },
    {
      type: 'checkpoint.restore.failed',
      payload: { checkpointId, message: '磁盘暂时不可写' },
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
    /*
     * 插件事件（ADR-0057）。`ghost` 是一个**没装着**的插件——这正是最该被样本覆盖的
     * 情形：持久化包含性、reduce 恒等、快照往返三件事都必须在"没人能解释这条记录"
     * 的前提下成立。
     */
    {
      type: 'ext.persisted',
      payload: { pluginId: 'ghost', name: 'commit.created', version: 1, data: { sha: 'abc' } },
    },
    {
      type: 'ext.transient',
      payload: { pluginId: 'ghost', name: 'index.progress', version: 1, data: { done: 3 } },
    },
    { type: 'turn.end', payload: { turnId, reason: 'end_turn' } },
  ];

  const covered = new Set(rows.map((r) => r.type));
  const missing = ALL_EVENT_TYPES.filter((t) => !covered.has(t));
  if (missing.length > 0) {
    throw new Error(`sample-events 缺少这些事件类型的样本：${missing.join(', ')}`);
  }
  /*
   * 占用投影不是事件（M3.5-f）。登记成类型之后，上面那条缺样本检查会逼你
   * 再补一条样本——那会让"塞进事件流"看起来像完成了契约，而不是被拦住。
   * 所以这里单独拒绝带 occupancy 的名字，补样本也过不了。
   */
  const occupancyTypes = ALL_EVENT_TYPES.filter((t) => t.includes('occupancy'));
  if (occupancyTypes.length > 0) {
    throw new Error(`占用投影不得登记为事件类型：${occupancyTypes.join('、')}`);
  }

  return rows.map((r) =>
    XmEventSchema.parse({
      id: newEventId(),
      sessionId,
      /*
       * 瞬态事件不占 seq 空间（见 kernel/state/reduce.ts）。
       *
       * 判据取自注册表的 `durability` 标注，**不是**手写一份瞬态类型名单：
       * 名单会漏——它当初就漏掉了新加的 `ext.transient`，而漏掉的表现是
       * "持久化包含性测试红了"，不是"少测了一种事件"。边界不会漏。
       */
      seq: isPersistedType(r.type) ? ++seq : Math.max(seq, 1),
      ts: 1_754_300_000_000 + seq,
      turnId,
      type: r.type,
      v: 1,
      payload: r.payload,
    }),
  );
}
