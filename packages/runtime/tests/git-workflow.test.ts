import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, composeRules, type PolicyEnv } from '@xm/kernel';
import { osFamily } from '@xm/platform';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';
import { gitBranchTool, gitCommitTool, nodeToolGateway } from '@xm/tools-core';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-f Git 生产分发链路', () => {
  it('创建分支和显式范围提交均经过网关与策略，且不产生拒绝事件', async () => {
    const root = await repository();
    await writeFile(join(root, 'task.txt'), 'changed\n');
    const store = new MemoryEventStore();
    const runtime = await SessionRuntime.open({
      sessionId: newSessionId(),
      store,
      bus: new EventBus(),
    });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: root, modelRef: 'scripted/git' },
    });
    const tools = new ToolRegistry();
    tools.register(gitBranchTool({ os: osFamily() }));
    tools.register(gitCommitTool({ os: osFamily() }));
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
      model: 'scripted-git',
      gateway: nodeToolGateway({ home: root }),
    };

    await runTurn(
      {
        ...deps,
        provider: providerFor('git.branch', ['git', 'switch', '-c', 'codex/runtime-git']),
      },
      textInput('创建分支'),
    );
    await runTurn(
      {
        ...deps,
        provider: providerFor(
          'git.commit',
          ['git', 'commit', '--only', '-m', 'runtime git', '--', 'task.txt'],
        ),
      },
      textInput('提交任务文件'),
    );

    const events = [];
    for await (const event of store.read(runtime.sessionId)) events.push(event);
    expect(events.filter((event) => event.type === 'tool.end')).toHaveLength(2);
    expect(events.some((event) => event.type === 'permission.request')).toBe(false);
    expect(events.some((event) => event.type === 'permission.decision')).toBe(false);
    expect(git(root, 'branch', '--show-current').trim()).toBe('codex/runtime-git');
    expect(git(root, 'show', '--pretty=', '--name-only', 'HEAD').trim()).toBe('task.txt');
    await runtime.close();
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xm-runtime-git-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Runtime Test');
  git(root, 'config', 'user.email', 'runtime@example.invalid');
  await writeFile(join(root, 'task.txt'), 'base\n');
  git(root, 'add', 'task.txt');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

function providerFor(name: string, argv: readonly string[]): ScriptedProvider {
  const callId = newCallId();
  return new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'tool_call_start', id: callId, name },
          { kind: 'tool_call_delta', id: callId, argsJson: JSON.stringify({ argv }) },
          { kind: 'tool_call_end', id: callId },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
    ],
  });
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
