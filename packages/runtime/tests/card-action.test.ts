import { createHash } from 'node:crypto';
import { realpath as realpathCb } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { newCallId, newSessionId, type CallId, type EditProposalId, type SessionId } from '@xm/contracts';
import {
  MemoryBlobStore,
  MemoryEventStore,
  ToolRegistry,
  composeRules,
  projectSessionCards,
  type PolicyEnv,
} from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  runCardAction,
  runTurn,
  textInput,
  type TurnDeps,
} from '@xm/runtime';
import { localExecutionWorld, nodeCheckpointer, nodeToolGateway } from '@xm/tool-runtime';
import { editApplyTool, editPreviewTool, type EditProposalAccess } from '@xm/tools-core';

/**
 * 卡片动作通道的反向演练（ADR-0065）。
 *
 * 这一组同时承担 M2-e 的验收：`main/edit-review.ts` 删掉之后，
 * **逐块接受/拒绝的全套用例仍然全绿**——权限语义一个字没改，
 * 变的只是那条路现在从一次卡片点击开始，而不是从一个专用 IPC 开始。
 */

const roots: string[] = [];
const realNative = promisify(realpathCb.native);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const scenario = async () => {
  const root = await realNative(await mkdtemp(join(tmpdir(), 'xm-card-action-')));
  roots.push(root);
  const a = join(root, 'a.txt');
  const b = join(root, 'b.txt');
  await writeFile(a, 'A=旧\nA2=旧\n');
  await writeFile(b, 'B=旧\n');

  const blobs = new MemoryBlobStore((data) =>
    Promise.resolve(createHash('sha256').update(data).digest('hex')),
  );
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({
    sessionId,
    store: new MemoryEventStore(),
    bus: new EventBus(),
  });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: root, modelRef: 'scripted/test' },
  });
  const tools = new ToolRegistry();
  const access = runtimeAccess(runtime);
  tools.register(editPreviewTool(access));
  tools.register(editApplyTool(access));
  const env: PolicyEnv = {
    home: root,
    sourceRoot: join(root, 'app'),
    dataDir: join(root, 'data'),
    configDir: join(root, 'config'),
  };
  const deps: TurnDeps = {
    runtime,
    executor: localExecutionWorld,
    tools,
    layers: composeRules({ env }),
    model: 'scripted-1',
    provider: new ScriptedProvider({ turns: [{ chunks: [{ kind: 'stop', reason: 'end_turn' }] }] }),
    gateway: nodeToolGateway({ home: root }),
    checkpointer: nodeCheckpointer({ blobs }),
    blobs,
  };

  const previewCall = newCallId();
  await runTurn(
    {
      ...deps,
      provider: providerFor(previewCall, 'edit.preview', {
        files: [
          {
            path: 'a.txt',
            replacements: [
              { oldText: 'A=旧', newText: 'A=新', expectedMatches: 1 },
              { oldText: 'A2=旧', newText: 'A2=新', expectedMatches: 1 },
            ],
          },
          { path: 'b.txt', replacements: [{ oldText: 'B=旧', newText: 'B=新', expectedMatches: 1 }] },
        ],
      }),
    },
    textInput('预览编辑'),
  );
  return { root, a, b, runtime, tools, deps, previewCall };
};

describe('M3-f 卡片动作通道', () => {
  it('diff 卡片带 hunk 与两个动作，卡片里没有工具名也没有路径以外的执行描述', async () => {
    const { runtime, tools, previewCall } = await scenario();
    const card = projectSessionCards(runtime.state, tools).get(previewCall)?.result;
    expect(card?.kind).toBe('diff');
    if (card?.kind !== 'diff') throw new Error('期望 diff 卡片');
    expect(card.files).toHaveLength(2);
    expect(card.files[0]?.kind).toBe('hunks');
    expect(card.actions?.map((action) => action.actionId)).toEqual(['accept', 'reject-all']);
    // 卡片是给渲染层看的：它只该包含"哪些块可以选"，不该出现工具名
    expect(JSON.stringify(card)).not.toContain('edit.apply');
    expect(JSON.stringify(card)).not.toContain('edit.preview');
    await runtime.close();
  });

  it('只选一个 hunk：生成收窄提案并真的落盘，其余改动一个字节都不动', async () => {
    const { a, b, runtime, tools, deps, previewCall } = await scenario();
    const card = projectSessionCards(runtime.state, tools).get(previewCall)?.result;
    if (card?.kind !== 'diff' || card.files[0]?.kind !== 'hunks') throw new Error('期望 diff 卡片');
    const first = card.files[0].hunks[0]!.hunkId;

    const result = await runCardAction(deps, {
      callId: previewCall,
      actionId: 'accept',
      payload: { selected: [first] },
    });
    expect(result.dispatched).toBe(true);
    expect(await readFile(a, 'utf8')).toBe('A=新\nA2=旧\n');
    expect(await readFile(b, 'utf8')).toBe('B=旧\n');
    await runtime.close();
  });

  it('拒绝全部：落 edit.reviewed，不产生任何写入，也不产生新的工具调用', async () => {
    const { a, runtime, deps, previewCall } = await scenario();
    const result = await runCardAction(deps, {
      callId: previewCall,
      actionId: 'reject-all',
      payload: {},
    });
    expect(result.dispatched).toBe(false);
    expect(await readFile(a, 'utf8')).toBe('A=旧\nA2=旧\n');
    expect(runtime.state.editProposals[0]?.reviewedAt).toBeDefined();
    expect(runtime.state.editProposals[0]?.appliedAt).toBeUndefined();
    await runtime.close();
  });

  it('审阅期间文件漂移：零文件写入，动作以错误告终', async () => {
    const { a, runtime, tools, deps, previewCall } = await scenario();
    const card = projectSessionCards(runtime.state, tools).get(previewCall)?.result;
    if (card?.kind !== 'diff' || card.files[0]?.kind !== 'hunks') throw new Error('期望 diff 卡片');
    await writeFile(a, '用户自己改过了');
    await expect(
      runCardAction(deps, {
        callId: previewCall,
        actionId: 'accept',
        payload: { selected: [card.files[0].hunks[0]!.hunkId] },
      }),
    ).rejects.toThrow(/漂移/u);
    expect(await readFile(a, 'utf8')).toBe('用户自己改过了');
    await runtime.close();
  });

  it('🔴 伪造一个指向别的会话的 callId：拒绝，且什么也不执行', async () => {
    const { runtime, deps } = await scenario();
    await expect(
      runCardAction(deps, { callId: newCallId(), actionId: 'accept', payload: { selected: [] } }),
    ).rejects.toThrow(/不属于当前会话/u);
    await runtime.close();
  });

  it('🔴 工具没声明的 actionId：失败关闭', async () => {
    const { runtime, deps, previewCall } = await scenario();
    await expect(
      runCardAction(deps, { callId: previewCall, actionId: 'rm-rf', payload: {} }),
    ).rejects.toThrow(/没有声明动作/u);
    await runtime.close();
  });

  it('🔴 载荷里塞一个不属于这张卡片的选择项：拒绝，不生成任何派生提案', async () => {
    const { runtime, deps, previewCall } = await scenario();
    await expect(
      runCardAction(deps, {
        callId: previewCall,
        actionId: 'accept',
        payload: { selected: ['../../etc/passwd'] },
      }),
    ).rejects.toThrow(/不属于该提案/u);
    expect(runtime.state.editProposals).toHaveLength(1);
    await runtime.close();
  });

  /*
   * ADR-0065 的核心演练：**动作通道不是审批通道。**
   *
   * 这里把工作区之外的一个文件塞进原始提案（模拟"模型先诱导出一个越界的 diff"），
   * 然后由用户点"接受"。点击不构成任何放行理由——那次写入照常走网关规范化与红线判定，
   * 必须被拦下。
   */
  it('🔴 动作触发的写入照样过闸门：越界路径被拒，磁盘不变', async () => {
    const { root, runtime, tools, deps, previewCall } = await scenario();
    const outside = await realNative(await mkdtemp(join(tmpdir(), 'xm-outside-')));
    roots.push(outside);
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, '不该被改\n');

    // 直接构造一份"指向工作区外"的提案，绕过 preview（模型有很多办法拿到这样一份提案）
    const evil = await runCardActionFixture(runtime, victim);
    const denyLayers = composeRules({
      env: {
        home: root,
        sourceRoot: join(root, 'app'),
        dataDir: join(root, 'data'),
        configDir: join(root, 'config'),
      },
      user: [
        {
          id: 'test.deny-outside',
          effect: 'deny',
          capability: 'fs.write',
          match: { target: `${outside.replaceAll('\\', '/')}/**` },
          reason: '工作区之外',
          immutable: false,
        },
      ],
    });
    const applyCall = newCallId();
    await runTurn(
      {
        ...deps,
        layers: denyLayers,
        provider: providerFor(applyCall, 'edit.apply', {
          proposalId: evil.proposalId,
          files: evil.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
        }),
        callOrigins: new Map([[applyCall, { kind: 'user-action', fromCallId: previewCall, actionId: 'accept' }]]),
      },
      textInput('用户在卡片上点了「应用选中」。'),
    );
    expect(await readFile(victim, 'utf8')).toBe('不该被改\n');
    const events = [];
    for await (const event of runtime.read()) events.push(event);
    const end = events.find((event) => event.type === 'tool.end' && event.payload.callId === applyCall);
    expect(end?.type === 'tool.end' ? end.payload.error?.code : undefined).toBe('policy_denied');
    /*
     * 被拒的调用**根本没有 tool.start**：`dispatchCall` 判定为 deny 时直接 failCall，
     * 连"开始执行"这条事件都不产生。这不是漏记——它正是"闸门在执行之前"的可观察形态，
     * 也说明这次点击一步都没有走到写盘那一侧。
     */
    expect(
      events.some((event) => event.type === 'tool.start' && event.payload.callId === applyCall),
    ).toBe(false);
    const denial = events.find(
      (event) => event.type === 'permission.decision' && event.payload.effect === 'deny',
    );
    expect(denial?.type === 'permission.decision' ? denial.payload.ruleId : undefined).toBe(
      'test.deny-outside',
    );
    await runtime.close();
    void tools;
  });

  it('由动作触发的写入在事件流里 origin.kind = user-action，且回指那张卡片', async () => {
    const { runtime, tools, deps, previewCall } = await scenario();
    const card = projectSessionCards(runtime.state, tools).get(previewCall)?.result;
    if (card?.kind !== 'diff' || card.files[0]?.kind !== 'hunks') throw new Error('期望 diff 卡片');
    await runCardAction(deps, {
      callId: previewCall,
      actionId: 'accept',
      payload: { selected: [card.files[0].hunks[0]!.hunkId] },
    });

    const starts = [];
    for await (const event of runtime.read()) {
      if (event.type === 'tool.start') starts.push(event.payload);
    }
    // 第一次是模型发起的 preview，第二次是用户点出来的 apply
    expect(starts[0]?.origin).toBeUndefined();
    expect(starts[1]?.name).toBe('edit.apply');
    expect(starts[1]?.origin).toEqual({
      kind: 'user-action',
      fromCallId: previewCall,
      actionId: 'accept',
    });
    await runtime.close();
  });

  it('🔴 同一张卡片点两次：第二次被拒，不会应用两遍', async () => {
    const { runtime, tools, deps, previewCall } = await scenario();
    const card = projectSessionCards(runtime.state, tools).get(previewCall)?.result;
    if (card?.kind !== 'diff' || card.files[0]?.kind !== 'hunks') throw new Error('期望 diff 卡片');
    const payload = { selected: [card.files[0].hunks[0]!.hunkId] };
    await runCardAction(deps, { callId: previewCall, actionId: 'accept', payload });
    await expect(
      runCardAction(deps, { callId: previewCall, actionId: 'accept', payload }),
    ).rejects.toThrow(/已处理/u);
    await runtime.close();
  });
});

/** 造一份指向工作区之外的提案，模拟"模型诱导出的越界 diff" */
async function runCardActionFixture(runtime: SessionRuntime, victim: string) {
  const { createEditProposal } = await import('@xm/tools-core');
  const proposal = await createEditProposal(
    [{ path: victim, replacements: [{ oldText: '不该被改', newText: '被改了', expectedMatches: 1 }] }],
    localExecutionWorld.fs,
  );
  await runtime.record({ type: 'edit.proposed', payload: { proposal } });
  return proposal;
}

function runtimeAccess(runtime: SessionRuntime): EditProposalAccess {
  return {
    save: async (_sessionId: SessionId, proposal) => {
      await runtime.record({ type: 'edit.proposed', payload: { proposal } });
    },
    get: (_sessionId: SessionId, proposalId: EditProposalId) => {
      const item = runtime.state.editProposals.find(
        (candidate) => candidate.proposal.proposalId === proposalId,
      );
      return Promise.resolve(
        item === undefined
          ? undefined
          : {
              proposal: item.proposal,
              applied: item.appliedAt !== undefined,
              reviewed: item.reviewedAt !== undefined,
            },
      );
    },
    markApplied: async (_sessionId: SessionId, proposalId: EditProposalId) => {
      await runtime.record({ type: 'edit.applied', payload: { proposalId } });
    },
    markReviewed: async (
      _sessionId: SessionId,
      proposalId: EditProposalId,
      selectedHunkIds: readonly string[],
    ) => {
      await runtime.record({
        type: 'edit.reviewed',
        payload: { proposalId, selectedHunkIds: [...selectedHunkIds] },
      });
    },
  };
}

function providerFor(callId: CallId, name: string, input: unknown): ScriptedProvider {
  return new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'tool_call_start', id: callId, name },
          { kind: 'tool_call_delta', id: callId, argsJson: JSON.stringify(input) },
          { kind: 'tool_call_end', id: callId },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
    ],
  });
}
