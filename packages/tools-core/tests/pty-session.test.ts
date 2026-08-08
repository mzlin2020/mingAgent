import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtySessionId, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { AbortLike, ToolContext } from '@xm/kernel';
import type { PtyLike, PtySessionEvent, SpawnPty } from '@xm/tools-core';
import {
  PtySessionError,
  PtySessionManager,
  shellSessionCloseTool,
  shellSessionOpenTool,
  shellSessionResizeTool,
  shellSessionWriteTool,
} from '@xm/tools-core';

/**
 * 一个可手动摆布的假 PTY：不碰真实进程，`onData`/`onExit` 由测试直接调用触发。
 * 这是这个仓库一贯的注入点风格（`dnsLookup`/`env` 同理）——生产用真实 node-pty，
 * 测试用假实现，两边共用同一份判断/归约逻辑。
 */
function fakePty(): PtyLike & { fireData: (chunk: string) => void; fireExit: (code: number) => void } {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 4242,
    onData: (l) => {
      dataListener = l;
      return { dispose: () => undefined };
    },
    onExit: (l) => {
      exitListener = l;
      return { dispose: () => undefined };
    },
    write: vi.fn(),
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

const ctxOf = (sessionId: SessionId): ToolContext => ({
  sessionId,
  signal: NEVER,
  cwd: '/w',
  executor: 'local',
});

describe('PtySessionManager（ADR-0031）', () => {
  let events: { sessionId: SessionId; event: PtySessionEvent }[];
  let ptys: ReturnType<typeof fakePty>[];
  let spawnPty: SpawnPty;
  let manager: PtySessionManager;
  let xmSession: SessionId;

  beforeEach(() => {
    events = [];
    ptys = [];
    spawnPty = () => {
      const p = fakePty();
      ptys.push(p);
      return p;
    };
    manager = new PtySessionManager({
      os: 'linux',
      emit: (sessionId, event) => {
        events.push({ sessionId, event });
      },
      spawnPty,
    });
    xmSession = newSessionId();
  });

  it('open() 产出一个 ptySessionId 并发 shell.session.opened', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    expect(typeof id).toBe('string');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual({
      type: 'shell.session.opened',
      payload: { ptySessionId: id, cwd: '/w', cols: 80, rows: 24 },
    });
    expect(manager.countFor(xmSession)).toBe(1);
  });

  it('write() 转发给底层 pty，onData 触发 shell.session.output', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.write(xmSession, id, 'echo hi\n');
    expect(ptys[0]?.write).toHaveBeenCalledWith('echo hi\n');

    ptys[0]?.fireData('hi\n');
    const out = events.at(-1);
    expect(out?.event).toEqual({
      type: 'shell.session.output',
      payload: { ptySessionId: id, chunk: 'hi\n' },
    });
  });

  it('resize() 转发列数/行数', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.resize(xmSession, id, 120, 40);
    expect(ptys[0]?.resize).toHaveBeenCalledWith(120, 40);
  });

  it('close() 杀掉进程，onExit 触发时 reason=killed', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    manager.close(xmSession, id);
    expect(ptys[0]?.kill).toHaveBeenCalled();

    ptys[0]?.fireExit(0);
    const closed = events.at(-1);
    expect(closed?.event).toEqual({
      type: 'shell.session.closed',
      payload: { ptySessionId: id, exitCode: 0, reason: 'killed', tail: '' },
    });
    expect(manager.countFor(xmSession)).toBe(0);
  });

  it('没人叫它关、进程自己退出 —— reason=exited', () => {
    manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    ptys[0]?.fireExit(1);
    const closed = events.at(-1);
    expect(closed?.event.type).toBe('shell.session.closed');
    expect(closed?.event.payload).toMatchObject({ reason: 'exited', exitCode: 1 });
  });

  it('归属不对：另一个 xm 会话碰不到这个 PTY，报错与"不存在"一模一样', () => {
    const id = manager.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    const other = newSessionId();
    expect(() => {
      manager.write(other, id, 'x');
    }).toThrow(PtySessionError);
    expect(() => {
      manager.write(other, id, 'x');
    }).toThrow(/不存在或已经关闭/);
    // 没有真的转发给底层 pty
    expect(ptys[0]?.write).not.toHaveBeenCalled();
  });

  it('不存在的 ptySessionId 同样报"不存在或已经关闭"', () => {
    expect(() => {
      manager.close(xmSession, 'nope' as PtySessionId);
    }).toThrow(/不存在或已经关闭/);
  });

  it('单个 xm 会话开满上限后拒绝再开', () => {
    const small = new PtySessionManager({
      os: 'linux',
      emit: () => undefined,
      spawnPty,
      maxSessionsPerXmSession: 2,
    });
    small.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    small.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    expect(() =>
      small.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 }),
    ).toThrow(/上限/);
    // 换一个 xm 会话不受影响 —— 上限是按会话分的
    expect(() =>
      small.open({ xmSessionId: newSessionId(), cwd: '/w', cols: 80, rows: 24 }),
    ).not.toThrow();
  });

  it('尾巴超过上限只保留最后一段', () => {
    const tiny = new PtySessionManager({
      os: 'linux',
      emit: (s, e) => events.push({ sessionId: s, event: e }),
      spawnPty,
      maxTailChars: 5,
    });
    const id = tiny.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
    ptys[0]?.fireData('abcdefgh');
    ptys[0]?.fireExit(0);
    const closed = events.at(-1);
    expect(closed?.event.payload).toMatchObject({ ptySessionId: id, tail: 'defgh' });
  });

  it('空闲超时会主动关闭，reason=idle_timeout', () => {
    vi.useFakeTimers();
    try {
      const timed = new PtySessionManager({
        os: 'linux',
        emit: (s, e) => events.push({ sessionId: s, event: e }),
        spawnPty,
        idleTimeoutMs: 1000,
      });
      timed.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
      vi.advanceTimersByTime(1000);
      expect(ptys[0]?.kill).toHaveBeenCalled();
      ptys[0]?.fireExit(0);
      const closed = events.at(-1);
      expect(closed?.event.payload).toMatchObject({ reason: 'idle_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('写入会重置空闲计时器', () => {
    vi.useFakeTimers();
    try {
      const timed = new PtySessionManager({
        os: 'linux',
        emit: () => undefined,
        spawnPty,
        idleTimeoutMs: 1000,
      });
      const id = timed.open({ xmSessionId: xmSession, cwd: '/w', cols: 80, rows: 24 });
      vi.advanceTimersByTime(700);
      timed.write(xmSession, id, 'x');
      vi.advanceTimersByTime(700);
      // 700+700=1400 > 1000，但中途写入过一次，不应该已经被 kill
      expect(ptys[0]?.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shell.session.* 四个工具（ADR-0031）', () => {
  let manager: PtySessionManager;
  let ptys: ReturnType<typeof fakePty>[];

  beforeEach(() => {
    ptys = [];
    manager = new PtySessionManager({
      os: 'linux',
      emit: () => undefined,
      spawnPty: () => {
        const p = fakePty();
        ptys.push(p);
        return p;
      },
    });
  });

  it('open 只声明 shell.session 这一个能力', () => {
    const tool = shellSessionOpenTool(manager);
    expect(tool.descriptor.capabilities).toEqual(['shell.session']);
    expect(tool.pathInputs).toEqual(['cwd']);
  });

  it.each([
    ['write', shellSessionWriteTool] as const,
    ['resize', shellSessionResizeTool] as const,
    ['close', shellSessionCloseTool] as const,
  ])('%s 声明空能力集 —— 打开之后不再判权', (_name, factory) => {
    expect(factory(manager).descriptor.capabilities).toEqual([]);
  });

  it('open → write → close 端到端跑一遍', async () => {
    const sessionId = newSessionId();
    const ctx = ctxOf(sessionId);

    let ptySessionId = '';
    for await (const p of shellSessionOpenTool(manager).execute({ cwd: '/w', cols: 80, rows: 24 }, ctx)) {
      if (p.kind === 'result') {
        const text = p.forModel[0];
        if (text?.type === 'text') ptySessionId = /：(.+)$/.exec(text.text)?.[1] ?? '';
      }
    }
    expect(ptySessionId).not.toBe('');
    expect(manager.countFor(sessionId)).toBe(1);

    for await (const p of shellSessionWriteTool(manager).execute(
      { ptySessionId, data: 'echo hi\n' },
      ctx,
    )) {
      void p; // 只关心不抛错
    }
    expect(ptys[0]?.write).toHaveBeenCalledWith('echo hi\n');

    for await (const p of shellSessionCloseTool(manager).execute({ ptySessionId }, ctx)) {
      void p; // 只关心不抛错
    }
    expect(ptys[0]?.kill).toHaveBeenCalled();
  });

  it('对着别的会话打开的 ptySessionId 写入 —— 得到错误文案而不是抛出', async () => {
    const owner = newSessionId();
    const intruder = newSessionId();
    const id = manager.open({ xmSessionId: owner, cwd: '/w', cols: 80, rows: 24 });

    let text = '';
    for await (const p of shellSessionWriteTool(manager).execute(
      { ptySessionId: id, data: 'x' },
      ctxOf(intruder),
    )) {
      if (p.kind === 'result' && p.forModel[0]?.type === 'text') text = p.forModel[0].text;
    }
    expect(text).toMatch(/不存在或已经关闭/);
  });
});
