import { localExecutionWorld } from '@xm/tool-runtime';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCallId, newCheckpointId, newSessionId } from '@xm/contracts';
import { nodePlatform } from '@xm/platform';
import { openStores } from '@xm/storage';
import { EventBus, SessionRuntime } from '@xm/runtime';
import { nodeCheckpointer, nodeCheckpointRestorer } from '@xm/tool-runtime';
import { fsWriteTool } from '@xm/tools-core';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Checkpoint v2 重启集成', () => {
  it('重启后仍能查看、恢复，并由事件回放出 restored 状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-checkpoint-integration-'));
    roots.push(root);
    const target = join(root, 'workspace', 'data.bin');
    await mkdir(join(root, 'workspace'));
    await writeFile(target, Buffer.from([0, 1, 2, 0xfe, 0xff]));
    const dataDir = join(root, 'data');
    const paths = nodePlatform({ appPath: root, dataDir }).paths();
    const sessionId = newSessionId();
    const checkpointId = newCheckpointId();

    let stores = await openStores(paths);
    let runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus: new EventBus() });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: join(root, 'workspace'), modelRef: 'scripted/test' },
    });
    const created = await nodeCheckpointer({ blobs: stores.blobs }).before(
      fsWriteTool(),
      { path: target, content: 'new' },
      {
        sessionId,
        cwd: join(root, 'workspace'),
        executor: localExecutionWorld,
        signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
      },
      [{ capability: 'fs.write', target }],
    );
    await runtime.record({
      type: 'checkpoint.created',
      payload: {
        checkpointId,
        kind: 'fs',
        ref: created!.record!.ref,
        label: created!.record!.label,
        manifestRef: created!.record!.manifestRef!,
        callId: newCallId(),
      },
    });
    await writeFile(target, 'CHANGED');
    await runtime.close();
    await stores.close();

    stores = await openStores(paths);
    runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus: new EventBus() });
    const replayed = runtime.state.checkpoints[0]!;
    expect(replayed.restoredAt).toBeUndefined();
    expect(replayed.manifestRef).toBeDefined();
    await runtime.record({ type: 'checkpoint.restore.started', payload: { checkpointId } });
    await nodeCheckpointRestorer(stores.blobs).restore(replayed.manifestRef!);
    await runtime.record({ type: 'checkpoint.restored', payload: { checkpointId } });
    expect([...await readFile(target)]).toEqual([0, 1, 2, 0xfe, 0xff]);
    await runtime.close();
    await stores.close();

    stores = await openStores(paths);
    runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus: new EventBus() });
    expect(runtime.state.checkpoints[0]!.restoredAt).toBeTypeOf('number');
    expect(runtime.state.checkpoints[0]!.restoreStartedAt).toBeUndefined();
    await runtime.close();
    await stores.close();
  });
});
