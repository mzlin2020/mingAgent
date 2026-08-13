import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCallId, newSessionId, type EditProposalId, type SessionId } from '@xm/contracts';
import {
  MemoryBlobStore,
  MemoryEventStore,
  ToolRegistry,
  composeRules,
  type PolicyEnv,
} from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';
import {
  editApplyTool,
  editPreviewTool,
  nodeCheckpointer,
  nodeCheckpointRestorer,
  nodeToolGateway,
  writeTextAtomic,
  type EditProposalAccess,
} from '@xm/tools-core';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-d 多文件事务真实链路', () => {
  it('第二个文件落盘失败时，整组 checkpoint 能撤销已写入的第一个文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-edit-transaction-'));
    roots.push(root);
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'A=旧\n');
    await writeFile(b, 'B=旧\n');

    const store = new MemoryEventStore();
    const blobs = new MemoryBlobStore((data) =>
      Promise.resolve(createHash('sha256').update(data).digest('hex')),
    );
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: root, modelRef: 'scripted/test' },
    });
    const access = runtimeAccess(runtime);
    let writes = 0;
    const tools = new ToolRegistry();
    tools.register(editPreviewTool(access));
    tools.register(editApplyTool(access, async (path, content) => {
      writes += 1;
      if (writes === 2) throw new Error('injected second write failure');
      await writeTextAtomic(path, content);
    }));
    const env: PolicyEnv = {
      home: root,
      appRoot: join(root, 'app'),
      dataDir: join(root, 'data'),
      configDir: join(root, 'config'),
    };
    const deps = {
      runtime,
      tools,
      layers: composeRules({ env }),
      model: 'scripted-1',
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
            { path: 'a.txt', replacements: [{ oldText: '旧', newText: '新', expectedMatches: 1 }] },
            { path: 'b.txt', replacements: [{ oldText: '旧', newText: '新', expectedMatches: 1 }] },
          ],
        }),
      },
      textInput('预览两处编辑'),
    );
    const proposal = runtime.state.editProposals[0]!.proposal;

    const applyCall = newCallId();
    await runTurn(
      {
        ...deps,
        provider: providerFor(applyCall, 'edit.apply', {
          proposalId: proposal.proposalId,
          files: proposal.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
        }),
      },
      textInput('应用提案'),
    );

    expect(await readFile(a, 'utf8')).toBe('A=新\n');
    expect(await readFile(b, 'utf8')).toBe('B=旧\n');
    expect(runtime.state.editProposals[0]!.appliedAt).toBeUndefined();
    const checkpoint = runtime.state.checkpoints.find((item) => item.callId === applyCall)!;
    expect(checkpoint.manifestRef).toBeDefined();
    const manifest = await nodeCheckpointRestorer(blobs).inspect(checkpoint.manifestRef!);
    expect(manifest.targets).toHaveLength(2);

    await nodeCheckpointRestorer(blobs).restore(checkpoint.manifestRef!);
    expect(await readFile(a, 'utf8')).toBe('A=旧\n');
    expect(await readFile(b, 'utf8')).toBe('B=旧\n');
    await runtime.close();
  });
});

function runtimeAccess(runtime: SessionRuntime): EditProposalAccess {
  return {
    save: async (_sessionId, proposal) => {
      await runtime.record({ type: 'edit.proposed', payload: { proposal } });
    },
    get: (_sessionId: SessionId, proposalId: EditProposalId) => {
      const item = runtime.state.editProposals.find(
        (candidate) => candidate.proposal.proposalId === proposalId,
      );
      return Promise.resolve(item === undefined
        ? undefined
        : { proposal: item.proposal, applied: item.appliedAt !== undefined });
    },
    markApplied: async (_sessionId, proposalId) => {
      await runtime.record({ type: 'edit.applied', payload: { proposalId } });
    },
  };
}

function providerFor(callId: ReturnType<typeof newCallId>, name: string, input: unknown) {
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
