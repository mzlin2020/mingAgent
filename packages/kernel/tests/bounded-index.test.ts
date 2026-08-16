import { describe, expect, it } from 'vitest';
import type { CallId, EditProposal, XmEvent } from '@xm/contracts';
import { newCallId, newEditProposalId, newSessionId } from '@xm/contracts';
import { emptySessionState, reduce, reduceAll } from '@xm/kernel';
import {
  EDIT_PROPOSAL_LIMIT,
  PRESENTATION_LIMIT,
} from '../src/state/bounded-index.js';

/**
 * 会话状态两张副表的上界（ADR-0070）。
 *
 * 这两张表过去只增不删，而单条可能比产生它的那条消息大一个量级
 * （一份提案带着完整 diff 与每一处 old/new 文本），且整份跟着 `readSession` 过 IPC。
 *
 * **循环条数写死，不从上界常量算。** 反向演练要把上界调大来看这些断言变红，
 * 若条数跟着常量走，调大上界只会让测试自己跑到内存耗尽——那不叫红，那叫没跑。
 */
const PRESENTATIONS = 296; // > PRESENTATION_LIMIT(256)
const PROPOSALS = 74; //     > EDIT_PROPOSAL_LIMIT(64)

const sessionId = newSessionId();
let seq = 0;
const at = (type: string): { seq: number; ts: number; id: string; sessionId: string } => ({
  seq: (seq += 1),
  ts: 1_700_000_000_000 + seq,
  id: `${type}-${String(seq)}`,
  sessionId,
});

const toolEnd = (callId: CallId, presentation: unknown): XmEvent =>
  ({
    ...at('tool.end'),
    type: 'tool.end',
    payload: {
      callId,
      ok: true,
      forModel: [{ type: 'text', text: 'ok' }],
      presentation,
    },
  }) as unknown as XmEvent;

const proposal = (path: string): EditProposal => ({
  proposalId: newEditProposalId(),
  files: [
    {
      path,
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      replacements: [{ oldText: '旧', newText: '新', expectedMatches: 1 }],
      diff: `--- ${path}\n+++ ${path}\n-旧\n+新\n`,
    },
  ],
});

const proposed = (p: EditProposal): XmEvent =>
  ({ ...at('edit.proposed'), type: 'edit.proposed', payload: { proposal: p } }) as unknown as XmEvent;

const applied = (p: EditProposal): XmEvent =>
  ({
    ...at('edit.applied'),
    type: 'edit.applied',
    payload: { proposalId: p.proposalId },
  }) as unknown as XmEvent;

describe('presentations 的上界', () => {
  it(`超过 ${String(PRESENTATION_LIMIT)} 条后只留最近的那些，最早的被淘汰`, () => {
    const events: XmEvent[] = [];
    const ids: CallId[] = [];
    for (let i = 0; i < PRESENTATIONS; i += 1) {
      const callId = newCallId();
      ids.push(callId);
      events.push(toolEnd(callId, { kind: 'hunks', index: i }));
    }
    const state = reduceAll(emptySessionState(sessionId), events);

    expect(state.presentations.size).toBe(PRESENTATION_LIMIT);
    expect(state.presentations.has(ids[0]!)).toBe(false);
    expect(state.presentations.has(ids[39]!)).toBe(false);
    expect(state.presentations.has(ids[40]!)).toBe(true);
    expect(state.presentations.get(ids.at(-1)!)).toEqual({
      kind: 'hunks',
      index: PRESENTATIONS - 1,
    });
  });

  /**
   * 快照一致性——这次改动**唯一**可能引入静默不一致的地方。
   *
   * 淘汰是按插入顺序做的，所以"从中途某个状态接着 reduce 尾部"必须与"从头全量 reduce"
   * 给出同一张表。`SessionRuntime` 每 500 条持久事件存一份快照、命中时只补读尾部
   * （ADR-0032），两条路给出不同结果的话，用户会看到一个"看起来对、实际不对"的会话。
   */
  it('🔴 从中途快照接着回放，与全量回放给出同一张表', () => {
    const events: XmEvent[] = [];
    for (let i = 0; i < PRESENTATIONS; i += 1) {
      events.push(toolEnd(newCallId(), { index: i }));
    }
    const full = reduceAll(emptySessionState(sessionId), events);

    const cut = 246; // 切在上界（256）之前，让恢复段跨过淘汰开始的那一刻
    const mid = reduceAll(emptySessionState(sessionId), events.slice(0, cut));
    const resumed = events.slice(cut).reduce(reduce, mid);

    expect([...resumed.presentations.entries()]).toEqual([...full.presentations.entries()]);
  });

  it('同一个 callId 重复写入会排到队尾，不占着原来的位置', () => {
    const first = newCallId();
    const state = reduceAll(emptySessionState(sessionId), [
      toolEnd(first, { v: 1 }),
      toolEnd(newCallId(), { v: 2 }),
      toolEnd(first, { v: 3 }),
    ]);
    expect([...state.presentations.values()]).toEqual([{ v: 2 }, { v: 3 }]);
  });
});

describe('editProposals 的上界', () => {
  it('终态提案优先被淘汰，未应用的留下', () => {
    const events: XmEvent[] = [];
    const kept: EditProposal[] = [];
    // 先塞满一批已应用的（终态）
    for (let i = 0; i < 64; i += 1) {
      const p = proposal(`/w/old-${String(i)}.ts`);
      events.push(proposed(p), applied(p));
    }
    // 再来 10 条没应用的
    for (let i = 0; i < 10; i += 1) {
      const p = proposal(`/w/new-${String(i)}.ts`);
      kept.push(p);
      events.push(proposed(p));
    }
    const state = reduceAll(emptySessionState(sessionId), events);

    expect(state.editProposals.length).toBe(EDIT_PROPOSAL_LIMIT);
    for (const p of kept) {
      expect(
        state.editProposals.some((item) => item.proposal.proposalId === p.proposalId),
      ).toBe(true);
    }
    // 被挤掉的正好是 10 条最旧的终态提案
    expect(state.editProposals.filter((item) => item.appliedAt !== undefined).length).toBe(
      EDIT_PROPOSAL_LIMIT - 10,
    );
  });

  it('全是非终态时，从最旧的开始淘汰', () => {
    const events: XmEvent[] = [];
    const all: EditProposal[] = [];
    for (let i = 0; i < 69; i += 1) {
      const p = proposal(`/w/${String(i)}.ts`);
      all.push(p);
      events.push(proposed(p));
    }
    const state = reduceAll(emptySessionState(sessionId), events);

    expect(state.editProposals.length).toBe(EDIT_PROPOSAL_LIMIT);
    expect(state.editProposals[0]?.proposal.proposalId).toBe(all[69 - EDIT_PROPOSAL_LIMIT]?.proposalId);
    expect(state.editProposals.at(-1)?.proposal.proposalId).toBe(all.at(-1)?.proposalId);
  });

  it('🔴 从中途快照接着回放，与全量回放给出同一份列表', () => {
    const events: XmEvent[] = [];
    for (let i = 0; i < PROPOSALS; i += 1) {
      const p = proposal(`/w/${String(i)}.ts`);
      events.push(proposed(p));
      if (i % 3 === 0) events.push(applied(p));
    }
    const full = reduceAll(emptySessionState(sessionId), events);

    const cut = 40;
    const mid = reduceAll(emptySessionState(sessionId), events.slice(0, cut));
    const resumed = events.slice(cut).reduce(reduce, mid);

    expect(resumed.editProposals).toEqual(full.editProposals);
  });
});
