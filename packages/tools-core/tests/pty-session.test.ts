import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtySessionId, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { AbortLike, ToolContext } from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import type { PtyLike, PtySessionEvent, SpawnPty } from '@xm/tools-core';
import {
  PtySessionError,
  PtySessionManager,
  shellSessionCloseTool,
  shellSessionOpenTool,
  shellSessionResizeTool,
  shellSessionRunTool,
  shellSessionStatusTool,
} from '@xm/tools-core';

function fakePty(): PtyLike & { fireData: (chunk: string) => void; fireExit: (code: number) => void } {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 4242,
    onData: (listener) => {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit: (listener) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    resize: vi.fn(),
    kill: vi.fn(),
    fireData: (chunk) => dataListener?.(chunk),
    fireExit: (code) => exitListener?.({ exitCode: code }),
  };
}

const NEVER: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const ctxOf = (sessionId: SessionId): ToolContext => ({ sessionId, signal: NEVER, cwd: '/w', executor: 'local' });

describe('controlled PTY sessions (ADR-0040)', () => {
  let events: { sessionId: SessionId; event: PtySessionEvent }[];
  let ptys: ReturnType<typeof fakePty>[];
  let calls: Parameters<SpawnPty>[];
  let manager: PtySessionManager;
  let xmSession: SessionId;

  beforeEach(() => {
    events = [];
    ptys = [];
    calls = [];
    const spawnPty: SpawnPty = (...args) => {
      calls.push(args);
      const pty = fakePty();
      ptys.push(pty);
      return pty;
    };
    manager = new PtySessionManager({
      os: 'linux',
      emit: (sessionId, event) => events.push({ sessionId, event }),
      spawnPty,
      env: { PATH: '/bin', SECRET_TOKEN: 'do-not-pass' },
    });
    xmSession = newSessionId();
  });

  it('open creates only a logical session and does not spawn a shell', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    expect(typeof id).toBe('string');
    expect(calls).toHaveLength(0);
    expect(manager.status(xmSession, id)).toEqual({ state: 'idle', tail: '' });
    expect(events[0]?.event.type).toBe('shell.session.opened');
  });

  it('run spawns argv directly with the environment allowlist and persists lifecycle events', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.run(xmSession, id, { argv: ['node', '--version'], cwd: '/tmp', timeoutMs: 5000 });
    expect(calls[0]?.[0]).toBe('node');
    expect(calls[0]?.[1]).toEqual(['--version']);
    expect(calls[0]?.[2]).toMatchObject({ cwd: '/tmp', env: { PATH: '/bin' } });
    expect(calls[0]?.[2].env).not.toHaveProperty('SECRET_TOKEN');
    expect(events.at(-1)?.event.type).toBe('shell.session.command.started');

    ptys[0]?.fireData('v24\n');
    expect(manager.status(xmSession, id)).toEqual({ state: 'running', tail: 'v24\n' });
    ptys[0]?.fireExit(0);
    expect(manager.status(xmSession, id)).toEqual({ state: 'exited', exitCode: 0, tail: 'v24\n' });
    expect(events.at(-1)?.event).toMatchObject({
      type: 'shell.session.command.finished',
      payload: { reason: 'exited', exitCode: 0 },
    });
  });

  it('run without cwd keeps the directory selected when the terminal was opened', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/project', cols: 80, rows: 24 });
    manager.run(xmSession, id, { argv: ['node', '--version'] });
    expect(calls[0]?.[2].cwd).toBe('/project');
  });

  it('spawn failure leaves the terminal idle and can be retried', () => {
    let attempts = 0;
    const flaky = new PtySessionManager({
      os: 'linux',
      emit: (sessionId, event) => events.push({ sessionId, event }),
      spawnPty: (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('File not found: node');
        calls.push(args);
        return fakePty();
      },
    });
    const id = flaky.open({ xmSessionId: xmSession, cwd: '/project', cols: 80, rows: 24 });

    expect(() => { flaky.run(xmSession, id, { argv: ['node'] }); }).toThrow(/File not found/);
    expect(flaky.status(xmSession, id)).toEqual({ state: 'idle', tail: '' });
    expect(events.some(({ event }) => event.type === 'shell.session.command.started')).toBe(false);
    expect(() => { flaky.run(xmSession, id, { argv: ['node'] }); }).not.toThrow();
    expect(flaky.status(xmSession, id).state).toBe('running');
  });

  it('allows only one in-flight process per terminal', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.run(xmSession, id, { argv: ['node', '--version'] });
    expect(() => { manager.run(xmSession, id, { argv: ['node', '--help'] }); }).toThrow(PtySessionError);
    ptys[0]?.fireExit(0);
    expect(() => { manager.run(xmSession, id, { argv: ['node', '--help'] }); }).not.toThrow();
  });

  it('timeout kills the active process and records timeout after exit', () => {
    vi.useFakeTimers();
    try {
      const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
      manager.run(xmSession, id, { argv: ['node'], timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(ptys[0]?.kill).toHaveBeenCalledOnce();
      ptys[0]?.fireExit(1);
      expect(manager.status(xmSession, id).state).toBe('timed_out');
      expect(events.at(-1)?.event).toMatchObject({
        type: 'shell.session.command.finished',
        payload: { reason: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('close kills an active process, removes ownership, and records closure', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.run(xmSession, id, { argv: ['node'] });
    manager.close(xmSession, id);
    expect(ptys[0]?.kill).toHaveBeenCalledOnce();
    expect(manager.countFor(xmSession)).toBe(0);
    expect(events.at(-2)?.event).toMatchObject({
      type: 'shell.session.command.finished',
      payload: { reason: 'killed' },
    });
    expect(events.at(-1)?.event).toMatchObject({ type: 'shell.session.closed', payload: { reason: 'killed' } });
  });

  it('enforces ownership for run, status, resize and close', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    const other = newSessionId();
    expect(() => { manager.run(other, id, { argv: ['node'] }); }).toThrow(PtySessionError);
    expect(() => manager.status(other, id)).toThrow(PtySessionError);
    expect(() => { manager.resize(other, id, 100, 30); }).toThrow(PtySessionError);
    expect(() => { manager.close(other, id); }).toThrow(PtySessionError);
  });

  it('bounds output tail and can mark a replayed lost session interrupted', () => {
    const tiny = new PtySessionManager({
      os: 'linux',
      emit: (sessionId, event) => events.push({ sessionId, event }),
      spawnPty: (...args) => {
        calls.push(args);
        const pty = fakePty();
        ptys.push(pty);
        return pty;
      },
      maxTailChars: 5,
    });
    const id = tiny.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    tiny.run(xmSession, id, { argv: ['node'] });
    ptys[0]?.fireData('abcdefgh');
    expect(tiny.status(xmSession, id).tail).toBe('defgh');
    tiny.interruptLost(xmSession, '11111111-1111-4111-8111-111111111111' as PtySessionId, 'old');
    expect(events.at(-1)?.event).toMatchObject({ type: 'shell.session.closed', payload: { reason: 'interrupted' } });
  });
});

describe('controlled PTY tools', () => {
  const manager = new PtySessionManager({ os: 'linux', emit: () => undefined, spawnPty: () => fakePty() });

  it('exposes run and status but no raw write tool', () => {
    const tools = [
      shellSessionOpenTool(manager),
      shellSessionRunTool(manager),
      shellSessionStatusTool(manager),
      shellSessionResizeTool(manager),
      shellSessionCloseTool(manager),
    ];
    expect(tools.map((tool) => tool.descriptor.name)).not.toContain('shell.session.write');
    expect(shellSessionRunTool(manager).descriptor.capabilities).toEqual(['shell.exec']);
    expect(shellSessionRunTool(manager).commandInputs).toMatchObject({ argv: 'argv', cwd: 'cwd' });
    expect(shellSessionRunTool(manager).commandInputs?.resolveCwd).toBeTypeOf('function');
  });

  it('run tool resolves its omitted cwd from the owned terminal session', () => {
    const sessionId = newSessionId();
    const id = manager.open({ xmSessionId: sessionId, cwd: '/project', cols: 80, rows: 24 });
    const commandInputs = shellSessionRunTool(manager).commandInputs;
    expect(commandInputs?.resolveCwd?.({ ptySessionId: id, argv: ['node'] }, ctxOf(sessionId))).toBe('/project');
  });

  it('run tool lets the runtime mark spawn failures as tool errors', async () => {
    const failing = new PtySessionManager({
      os: 'linux',
      emit: () => undefined,
      spawnPty: () => { throw new Error('spawn failed'); },
    });
    const sessionId = newSessionId();
    const id = failing.open({ xmSessionId: sessionId, cwd: '/project', cols: 80, rows: 24 });
    const execute = async (): Promise<void> => {
      const iterator = shellSessionRunTool(failing).execute(
        { ptySessionId: id, argv: ['node'] },
        ctxOf(sessionId),
      )[Symbol.asyncIterator]();
      await iterator.next();
    };
    await expect(execute()).rejects.toThrow(/spawn failed/);
    expect(failing.status(sessionId, id)).toEqual({ state: 'idle', tail: '' });
  });

  it('runs a bare executable name through the real Windows PTY', async () => {
    if (nodePlatform({ appRoot: process.cwd() }).os !== 'windows') return;
    const sessionId = newSessionId();
    const real = new PtySessionManager({ os: 'windows', emit: () => undefined });
    const id = real.open({ xmSessionId: sessionId, cwd: process.cwd(), cols: 80, rows: 24 });
    try {
      real.run(sessionId, id, {
        argv: ['node', '-e', "process.stdout.write('pty-ok')"],
        timeoutMs: 5000,
      });
      await vi.waitFor(() => {
        expect(real.status(sessionId, id).state).toBe('exited');
      }, { timeout: 10_000 });
      expect(real.status(sessionId, id).tail).toContain('pty-ok');
    } finally {
      real.close(sessionId, id);
    }
  });

  it('run tool starts a process and status returns bounded JSON', async () => {
    const sessionId = newSessionId();
    const ctx = ctxOf(sessionId);
    const id = manager.open({ xmSessionId: sessionId, cwd: '/w', cols: 80, rows: 24 });
    for await (const progress of shellSessionRunTool(manager).execute({ ptySessionId: id, argv: ['node'] }, ctx)) {
      expect(progress.kind).toBe('result');
    }
    let text = '';
    for await (const progress of shellSessionStatusTool(manager).execute({ ptySessionId: id }, ctx)) {
      if (progress.kind === 'result' && progress.forModel[0]?.type === 'text') text = progress.forModel[0].text;
    }
    expect(JSON.parse(text)).toMatchObject({ state: 'running' });
  });
});
