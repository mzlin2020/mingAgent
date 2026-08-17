import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtySessionId, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type {
  AbortLike,
  ExecutionPtyInput,
  ExecutionPtyProcess,
  ExecutionWorld,
  ToolContext,
} from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import { localExecutionWorld } from '@xm/tool-runtime';
import type { PtySessionEvent } from '@xm/tools-core';
import {
  PtySessionError,
  PtySessionManager,
  shellSessionCloseTool,
  shellSessionOpenTool,
  shellSessionResizeTool,
  shellSessionRunTool,
  shellSessionStatusTool,
} from '@xm/tools-core';

interface FakePty extends ExecutionPtyProcess {
  readonly kill: (() => void) & { readonly mock: { readonly calls: readonly unknown[][] } };
  fireData(chunk: string): void;
  fireExit(code: number): void;
}

function fakePty(): FakePty {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((code: number) => void) | undefined;
  return {
    onData: (listener) => { dataListener = listener; },
    onExit: (listener) => { exitListener = listener; },
    resize: vi.fn(),
    kill: vi.fn<() => void>(),
    fireData: (chunk) => dataListener?.(chunk),
    fireExit: (code) => exitListener?.(code),
  };
}

const NEVER: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const worldFor = (
  spawn: (input: ExecutionPtyInput) => Promise<ExecutionPtyProcess>,
): ExecutionWorld => ({ ...localExecutionWorld, pty: { spawn } });

const ctxOf = (sessionId: SessionId, executor: ExecutionWorld): ToolContext => ({
  sessionId, signal: NEVER, cwd: '/w', executor,
});

describe('controlled PTY sessions (ADR-0040)', () => {
  let events: { sessionId: SessionId; event: PtySessionEvent }[];
  let ptys: FakePty[];
  let calls: ExecutionPtyInput[];
  let manager: PtySessionManager;
  let executor: ExecutionWorld;
  let xmSession: SessionId;

  beforeEach(() => {
    events = [];
    ptys = [];
    calls = [];
    executor = worldFor((input) => {
      calls.push(input);
      const pty = fakePty();
      ptys.push(pty);
      return Promise.resolve(pty);
    });
    manager = new PtySessionManager({
      os: 'linux',
      emit: (sessionId, event) => events.push({ sessionId, event }),
      env: { PATH: '/bin', SECRET_TOKEN: 'do-not-pass' },
    });
    xmSession = newSessionId();
  });

  it('open 只创建逻辑会话，不启动进程', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    expect(calls).toHaveLength(0);
    expect(manager.status(xmSession, id)).toEqual({ state: 'idle', tail: '' });
  });

  it('run 把 argv、目录和环境白名单交给执行世界', async () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    await manager.run(executor, xmSession, id, {
      argv: ['node', '--version'], cwd: '/tmp', timeoutMs: 5000,
    });
    expect(calls[0]).toMatchObject({
      argv: ['node', '--version'], cwd: '/tmp', envSource: { PATH: '/bin', SECRET_TOKEN: 'do-not-pass' },
    });
    expect(calls[0]?.inheritEnv).toContain('PATH');
    ptys[0]?.fireData('v24\n');
    ptys[0]?.fireExit(0);
    expect(manager.status(xmSession, id)).toEqual({ state: 'exited', exitCode: 0, tail: 'v24\n' });
  });

  it('spawn 失败后仍为空闲，可重试', async () => {
    let attempts = 0;
    const flakyWorld = worldFor(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('File not found: node'))
        : Promise.resolve(fakePty());
    });
    const id = manager.open({ xmSessionId: xmSession, cwd: '/project', cols: 80, rows: 24 });
    await expect(manager.run(flakyWorld, xmSession, id, { argv: ['node'] })).rejects.toThrow(/File not found/u);
    expect(manager.status(xmSession, id).state).toBe('idle');
    await expect(manager.run(flakyWorld, xmSession, id, { argv: ['node'] })).resolves.toBeUndefined();
  });

  it('每个逻辑终端只允许一个在途进程', async () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    await manager.run(executor, xmSession, id, { argv: ['node'] });
    await expect(manager.run(executor, xmSession, id, { argv: ['node', '--help'] }))
      .rejects.toThrow(PtySessionError);
    ptys[0]?.fireExit(0);
    await expect(manager.run(executor, xmSession, id, { argv: ['node', '--help'] }))
      .resolves.toBeUndefined();
  });

  it('超时和关闭都经 provider 终止进程', async () => {
    vi.useFakeTimers();
    try {
      const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
      await manager.run(executor, xmSession, id, { argv: ['node'], timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(ptys[0]?.kill.mock.calls).toHaveLength(1);
      ptys[0]?.fireExit(1);
      expect(manager.status(xmSession, id).state).toBe('timed_out');
      manager.close(xmSession, id);
      expect(manager.countFor(xmSession)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('所有权与输出尾部上限保持不变', async () => {
    const tiny = new PtySessionManager({
      os: 'linux', maxTailChars: 5,
      emit: (sessionId, event) => events.push({ sessionId, event }),
    });
    const id = tiny.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    await tiny.run(executor, xmSession, id, { argv: ['node'] });
    ptys[0]?.fireData('abcdefgh');
    expect(tiny.status(xmSession, id).tail).toBe('defgh');
    const other = newSessionId();
    await expect(tiny.run(executor, other, id, { argv: ['node'] })).rejects.toThrow(PtySessionError);
    tiny.interruptLost(xmSession, '11111111-1111-4111-8111-111111111111' as PtySessionId, 'old');
  });
});

describe('controlled PTY tools', () => {
  const manager = new PtySessionManager({ os: 'linux', emit: () => undefined });

  it('暴露 run/status，不暴露原始 stdin', () => {
    const tools = [
      shellSessionOpenTool(manager), shellSessionRunTool(manager), shellSessionStatusTool(manager),
      shellSessionResizeTool(manager), shellSessionCloseTool(manager),
    ];
    expect(tools.map((tool) => tool.descriptor.name)).not.toContain('shell.session.write');
    expect(shellSessionRunTool(manager).descriptor.capabilities).toEqual(['shell.exec']);
  });

  it('run 工具使用 ToolContext 中的执行世界', async () => {
    const pty = fakePty();
    const executor = worldFor(() => Promise.resolve(pty));
    const sessionId = newSessionId();
    const id = manager.open({ xmSessionId: sessionId, cwd: '/project', cols: 80, rows: 24 });
    for await (const progress of shellSessionRunTool(manager).execute(
      { ptySessionId: id, argv: ['node'] }, ctxOf(sessionId, executor),
    )) {
      expect(progress.kind).toBe('result');
    }
  });

  it('Windows local provider 能解析裸 node 可执行名', async () => {
    if (nodePlatform({ appPath: process.cwd() }).os !== 'windows') return;
    const sessionId = newSessionId();
    const real = new PtySessionManager({ os: 'windows', emit: () => undefined });
    const id = real.open({ xmSessionId: sessionId, cwd: process.cwd(), cols: 80, rows: 24 });
    try {
      await real.run(localExecutionWorld, sessionId, id, {
        argv: ['node', '-e', "process.stdout.write('pty-ok')"], timeoutMs: 5000,
      });
      await vi.waitFor(() => { expect(real.status(sessionId, id).state).toBe('exited'); }, { timeout: 10_000 });
      expect(real.status(sessionId, id).tail).toContain('pty-ok');
    } finally {
      real.close(sessionId, id);
    }
  });
});
