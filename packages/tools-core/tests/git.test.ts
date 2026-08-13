import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import type { RegisteredTool, ToolContext } from '@xm/kernel';
import { osFamily } from '@xm/platform';
import {
  gitBranchTool,
  gitCommitTool,
  gitDiffTool,
  gitStatusTool,
  nodeToolGateway,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M2-f local git workflow', () => {
  it('status → branch → diff → commit 闭环不夹带用户既有暂存', async () => {
    const root = await repository();
    await writeFile(join(root, 'task.txt'), 'task changed\n');
    await writeFile(join(root, 'user.txt'), 'user changed\n');
    git(root, 'add', 'user.txt');

    const status = await execute(gitStatusTool({ os: os() }), {}, root);
    expect(status.kind).toBe('status');
    expect(status.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'task.txt' }),
      expect.objectContaining({ path: 'user.txt' }),
    ]));

    const branch = await execute(
      gitBranchTool({ os: os() }),
      { argv: ['git', 'switch', '-c', 'codex/m2-f'] },
      root,
    );
    expect(branch).toMatchObject({ ok: true, kind: 'branch' });

    const diff = await execute(
      gitDiffTool({ os: os() }),
      { argv: ['git', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'task.txt'] },
      root,
    );
    expect(diff.stdout).toContain('task changed');
    expect(diff.stdout).not.toContain('user changed');

    const committed = await execute(
      gitCommitTool({ os: os() }),
      { argv: ['git', 'commit', '--only', '-m', '完成任务改动', '--', 'task.txt'] },
      root,
    );
    expect(committed).toMatchObject({ ok: true, kind: 'commit', scope: ['M\ttask.txt'] });
    expect(git(root, 'show', '--pretty=', '--name-only', 'HEAD').trim()).toBe('task.txt');
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('user.txt');
    expect(git(root, 'branch', '--show-current').trim()).toBe('codex/m2-f');
  });

  it('支持显式提交新文件，同时保留其它暂存', async () => {
    const root = await repository();
    await writeFile(join(root, 'new.txt'), 'new\n');
    await writeFile(join(root, 'user.txt'), 'staged\n');
    git(root, 'add', 'user.txt');
    const result = await execute(
      gitCommitTool({ os: os() }),
      { argv: ['git', 'commit', '--only', '-m', '新增文件', '--', 'new.txt'] },
      root,
    );
    expect(result).toMatchObject({ ok: true, kind: 'commit' });
    expect(git(root, 'show', '--pretty=', '--name-only', 'HEAD').trim()).toBe('new.txt');
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('user.txt');
  });

  it('结构化区分非仓库、空提交与中断', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'xm-git-outside-'));
    roots.push(outside);
    expect(await execute(gitStatusTool({ os: os() }), {}, outside)).toMatchObject({
      ok: false,
      kind: 'not_repository',
    });

    const root = await repository();
    expect(await execute(
      gitCommitTool({ os: os() }),
      { argv: ['git', 'commit', '--only', '-m', '空', '--', 'task.txt'] },
      root,
    )).toMatchObject({ ok: false, kind: 'empty_commit' });

    expect(await execute(gitStatusTool({ os: os() }), {}, root, true)).toMatchObject({
      ok: false,
      kind: 'interrupted',
    });
  });

  it('用 Trace2 把 hook 失败与普通命令失败分开，并恢复原 index', async () => {
    const root = await repository();
    await writeFile(join(root, 'task.txt'), 'blocked\n');
    await writeFile(join(root, 'user.txt'), 'staged\n');
    git(root, 'add', 'user.txt');
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho blocked-by-hook >&2\nexit 7\n');
    await chmod(hook, 0o755);

    const result = await execute(
      gitCommitTool({ os: os() }),
      { argv: ['git', 'commit', '--only', '-m', '应被拦下', '--', 'task.txt'] },
      root,
    );
    expect(result).toMatchObject({ ok: false, kind: 'hook_failed', hook: 'pre-commit' });
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('user.txt');
    expect(git(root, 'diff', '--name-only').trim()).toBe('task.txt');
  });

  it('冲突时拒绝切分支；未列出的 git 子命令也拒绝', async () => {
    const root = await conflictedRepository();
    expect(await execute(
      gitBranchTool({ os: os() }),
      { argv: ['git', 'switch', '-c', 'should-not-exist'] },
      root,
    )).toMatchObject({ ok: false, kind: 'conflict' });
    expect(await execute(
      gitBranchTool({ os: os() }),
      { argv: ['git', 'push', 'origin', 'main'] },
      root,
    )).toMatchObject({ ok: false, kind: 'command_failed' });
  });

  it('diff 必须显式禁用外部 diff 与 textconv', async () => {
    const root = await repository();
    await writeFile(join(root, 'task.txt'), 'changed\n');

    expect(await execute(
      gitDiffTool({ os: os() }),
      { argv: ['git', 'diff', '--no-ext-diff', '--no-color', '--', 'task.txt'] },
      root,
    )).toMatchObject({ ok: false, kind: 'command_failed' });
    expect(await execute(
      gitDiffTool({ os: os() }),
      { argv: ['git', 'diff', '--no-textconv', '--no-color', '--', 'task.txt'] },
      root,
    )).toMatchObject({ ok: false, kind: 'command_failed' });
  });

  it('只读 Git 工具不会执行仓库配置的 fsmonitor hook', async () => {
    const root = await repository();
    const hook = join(root, '.git', 'hooks', 'fsmonitor-test');
    const marker = join(root, '.git', 'fsmonitor-invoked');
    await writeFile(hook, '#!/bin/sh\necho invoked > .git/fsmonitor-invoked\n');
    await chmod(hook, 0o755);
    git(root, 'config', 'core.fsmonitor', hook.replaceAll('\\', '/'));

    expect(await execute(gitStatusTool({ os: os() }), {}, root)).toMatchObject({
      ok: true,
      kind: 'status',
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('网关为写操作保留 shell.exec 与 git.write 两条静态主张', async () => {
    const root = await repository();
    const tool = gitBranchTool({ os: os() });
    const resolved = await nodeToolGateway().resolve(
      tool,
      tool.parseInput({ argv: ['git', 'switch', '-c', 'claims'] }),
      context(root),
    );
    expect(resolved.claims.map((claim) => claim.capability)).toEqual(
      expect.arrayContaining(['shell.exec', 'git.write']),
    );
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xm-git-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'M2 Test');
  git(root, 'config', 'user.email', 'm2@example.invalid');
  await writeFile(join(root, 'task.txt'), 'task base\n');
  await writeFile(join(root, 'user.txt'), 'user base\n');
  git(root, 'add', 'task.txt', 'user.txt');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

async function conflictedRepository(): Promise<string> {
  const root = await repository();
  git(root, 'switch', '-c', 'other');
  await writeFile(join(root, 'task.txt'), 'other\n');
  git(root, 'commit', '-am', 'other');
  git(root, 'switch', 'main');
  await writeFile(join(root, 'task.txt'), 'main\n');
  git(root, 'commit', '-am', 'main');
  try { git(root, 'merge', 'other'); } catch { /* 冲突正是夹具目标。 */ }
  return root;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function execute(
  tool: RegisteredTool,
  input: unknown,
  cwd: string,
  aborted = false,
): Promise<Record<string, unknown>> {
  let output = '';
  for await (const progress of tool.execute(input, context(cwd, aborted))) {
    if (progress.kind === 'result') output = progress.forModel[0]?.type === 'text' ? progress.forModel[0].text : '';
  }
  return JSON.parse(output) as Record<string, unknown>;
}

function context(cwd: string, aborted = false): ToolContext {
  return {
    sessionId: newSessionId(), cwd, executor: 'local',
    signal: { aborted, addEventListener: () => undefined, removeEventListener: () => undefined },
  };
}

const os = osFamily;
