import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { PtySessionId, SessionId } from '@xm/contracts';
import { newPtySessionId } from '@xm/contracts';
import type { OsFamily } from '@xm/kernel';
import { killProcessTree, shellChildEnv } from './shell-exec.js';
import { resolvePtyExecutable } from './pty-executable.js';

export const SHELL_SESSION_OPEN = 'shell.session.open';
export const SHELL_SESSION_RUN = 'shell.session.run';
export const SHELL_SESSION_STATUS = 'shell.session.status';
export const SHELL_SESSION_RESIZE = 'shell.session.resize';
export const SHELL_SESSION_CLOSE = 'shell.session.close';

export type PtyCloseReason = 'killed' | 'idle_timeout' | 'interrupted';
export type PtyCommandFinishReason = 'exited' | 'timeout' | 'killed';

export type PtySessionEvent =
  | {
      readonly type: 'shell.session.opened';
      readonly payload: {
        readonly ptySessionId: PtySessionId;
        readonly cwd: string;
        readonly cols: number;
        readonly rows: number;
      };
    }
  | {
      readonly type: 'shell.session.command.started';
      readonly payload: {
        readonly ptySessionId: PtySessionId;
        readonly argv: string[];
        readonly cwd: string;
        readonly timeoutMs: number;
      };
    }
  | {
      readonly type: 'shell.session.output';
      readonly payload: { readonly ptySessionId: PtySessionId; readonly chunk: string };
    }
  | {
      readonly type: 'shell.session.command.finished';
      readonly payload: {
        readonly ptySessionId: PtySessionId;
        readonly exitCode?: number;
        readonly reason: PtyCommandFinishReason;
        readonly tail: string;
      };
    }
  | {
      readonly type: 'shell.session.closed';
      readonly payload: {
        readonly ptySessionId: PtySessionId;
        readonly reason: PtyCloseReason;
        readonly tail: string;
      };
    };

export class PtySessionError extends Error {}

export type PtyLike = Pick<IPty, 'pid' | 'onData' | 'onExit' | 'resize' | 'kill'>;
export type SpawnPty = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly env: Record<string, string>;
  },
) => PtyLike;

export interface PtySessionManagerOptions {
  readonly os: OsFamily;
  readonly emit: (xmSessionId: SessionId, event: PtySessionEvent) => void;
  readonly maxSessionsPerXmSession?: number;
  readonly idleTimeoutMs?: number;
  readonly maxTailChars?: number;
  readonly spawnPty?: SpawnPty;
  readonly extraEnv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PtySessionStatus {
  readonly state: 'idle' | 'running' | 'exited' | 'timed_out' | 'killed';
  readonly exitCode?: number;
  readonly tail: string;
}

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TAIL_CHARS = 256 * 1024;

interface Entry {
  readonly xmSessionId: SessionId;
  readonly cwd: string;
  cols: number;
  rows: number;
  pty: PtyLike | undefined;
  tail: string;
  status: PtySessionStatus['state'];
  exitCode: number | undefined;
  commandReason: PtyCommandFinishReason | undefined;
  idleTimer: ReturnType<typeof setTimeout>;
  commandTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A logical terminal session. It never exposes raw stdin to model tools. Each command is an
 * already-tokenised argv vector and node-pty starts it directly (no intermediate shell).
 */
export class PtySessionManager {
  readonly #sessions = new Map<PtySessionId, Entry>();
  readonly #emit: PtySessionManagerOptions['emit'];
  readonly #maxSessions: number;
  readonly #idleTimeoutMs: number;
  readonly #maxTailChars: number;
  readonly #spawnPty: SpawnPty;
  readonly #env: Record<string, string>;
  readonly #os: OsFamily;

  constructor(options: PtySessionManagerOptions) {
    this.#emit = options.emit;
    this.#maxSessions = options.maxSessionsPerXmSession ?? DEFAULT_MAX_SESSIONS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#maxTailChars = options.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS;
    this.#spawnPty = options.spawnPty ?? defaultSpawnPty;
    this.#os = options.os;
    this.#env = shellChildEnv({
      os: options.os,
      ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  countFor(xmSessionId: SessionId): number {
    let count = 0;
    for (const entry of this.#sessions.values()) if (entry.xmSessionId === xmSessionId) count += 1;
    return count;
  }

  has(xmSessionId: SessionId, ptySessionId: PtySessionId): boolean {
    const entry = this.#sessions.get(ptySessionId);
    return entry?.xmSessionId === xmSessionId;
  }

  cwd(xmSessionId: SessionId, ptySessionId: PtySessionId): string {
    return this.#own(xmSessionId, ptySessionId).cwd;
  }

  open(input: {
    readonly xmSessionId: SessionId;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }): PtySessionId {
    if (this.countFor(input.xmSessionId) >= this.#maxSessions) {
      throw new PtySessionError(`已经打开 ${String(this.#maxSessions)} 个终端会话，达到上限。`);
    }
    const ptySessionId = newPtySessionId();
    const entry: Entry = {
      xmSessionId: input.xmSessionId,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      tail: '',
      status: 'idle',
      pty: undefined,
      exitCode: undefined,
      commandReason: undefined,
      commandTimer: undefined,
      idleTimer: this.#scheduleIdleTimeout(ptySessionId),
    };
    this.#sessions.set(ptySessionId, entry);
    this.#emit(input.xmSessionId, {
      type: 'shell.session.opened',
      payload: { ptySessionId, cwd: input.cwd, cols: input.cols, rows: input.rows },
    });
    return ptySessionId;
  }

  run(
    xmSessionId: SessionId,
    ptySessionId: PtySessionId,
    input: {
      readonly argv: readonly string[];
      readonly cwd?: string | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    if (entry.pty !== undefined) throw new PtySessionError('这个终端已有命令在运行，请等待或先关闭会话。');
    const [file, ...args] = input.argv;
    if (file === undefined || file === '') throw new PtySessionError('argv 至少需要一个非空程序名。');

    const cwd = input.cwd ?? entry.cwd;
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const executable = resolvePtyExecutable(file, { os: this.#os, cwd, env: this.#env });
    if (executable === undefined) throw new PtySessionError(`找不到可执行程序：${file}`);
    const pty = this.#spawnPty(executable, args, {
      cwd,
      cols: entry.cols,
      rows: entry.rows,
      env: this.#env,
    });
    entry.tail = '';
    entry.exitCode = undefined;
    entry.commandReason = undefined;
    entry.status = 'running';
    entry.pty = pty;
    this.#resetIdleTimer(ptySessionId, entry);
    this.#emit(xmSessionId, {
      type: 'shell.session.command.started',
      payload: { ptySessionId, argv: [...input.argv], cwd, timeoutMs },
    });
    pty.onData((chunk) => { this.#onData(ptySessionId, chunk); });
    pty.onExit(({ exitCode }) => { this.#onExit(ptySessionId, exitCode); });
    entry.commandTimer = setTimeout(() => {
      const current = this.#sessions.get(ptySessionId);
      if (current?.pty !== pty) return;
      current.commandReason = 'timeout';
      current.status = 'timed_out';
      killProcessTree(pty.pid, this.#os);
      pty.kill();
    }, timeoutMs);
    entry.commandTimer.unref();
  }

  status(xmSessionId: SessionId, ptySessionId: PtySessionId): PtySessionStatus {
    const entry = this.#own(xmSessionId, ptySessionId);
    return {
      state: entry.status,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      tail: entry.tail,
    };
  }

  resize(xmSessionId: SessionId, ptySessionId: PtySessionId, cols: number, rows: number): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    entry.cols = cols;
    entry.rows = rows;
    entry.pty?.resize(cols, rows);
  }

  close(xmSessionId: SessionId, ptySessionId: PtySessionId): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    if (entry.pty !== undefined) {
      if (entry.commandTimer !== undefined) clearTimeout(entry.commandTimer);
      entry.commandTimer = undefined;
      entry.status = 'killed';
      const pty = entry.pty;
      entry.pty = undefined;
      killProcessTree(pty.pid, this.#os);
      try {
        pty.kill();
      } catch {
        // 进程树清理可能已经先一步完成了。
      }
      this.#emit(entry.xmSessionId, {
        type: 'shell.session.command.finished',
        payload: { ptySessionId, reason: 'killed', tail: entry.tail },
      });
    }
    this.#finishSession(ptySessionId, entry, 'killed');
  }

  interruptLost(xmSessionId: SessionId, ptySessionId: PtySessionId, tail = ''): void {
    this.#emit(xmSessionId, {
      type: 'shell.session.closed',
      payload: { ptySessionId, reason: 'interrupted', tail },
    });
  }

  disposeAll(): void {
    for (const [, entry] of this.#sessions) {
      clearTimeout(entry.idleTimer);
      if (entry.commandTimer !== undefined) clearTimeout(entry.commandTimer);
      try {
        if (entry.pty !== undefined) {
          killProcessTree(entry.pty.pid, this.#os);
          entry.pty.kill();
        }
      } catch {
        // already exited
      }
    }
    this.#sessions.clear();
  }

  #own(xmSessionId: SessionId, ptySessionId: PtySessionId): Entry {
    const entry = this.#sessions.get(ptySessionId);
    if (entry?.xmSessionId !== xmSessionId) {
      throw new PtySessionError(`会话 ${ptySessionId} 不存在或已经关闭。`);
    }
    return entry;
  }

  #onData(ptySessionId: PtySessionId, chunk: string): void {
    const entry = this.#sessions.get(ptySessionId);
    if (entry === undefined) return;
    entry.tail = clip(entry.tail + chunk, this.#maxTailChars);
    this.#resetIdleTimer(ptySessionId, entry);
    this.#emit(entry.xmSessionId, {
      type: 'shell.session.output',
      payload: { ptySessionId, chunk },
    });
  }

  #onExit(ptySessionId: PtySessionId, exitCode: number): void {
    const entry = this.#sessions.get(ptySessionId);
    if (entry?.pty === undefined) return;
    if (entry.commandTimer !== undefined) clearTimeout(entry.commandTimer);
    entry.commandTimer = undefined;
    entry.pty = undefined;
    entry.exitCode = exitCode;
    const reason = entry.commandReason ?? 'exited';
    entry.commandReason = undefined;
    if (reason === 'exited') entry.status = 'exited';
    this.#emit(entry.xmSessionId, {
      type: 'shell.session.command.finished',
      payload: { ptySessionId, exitCode, reason, tail: entry.tail },
    });
    this.#resetIdleTimer(ptySessionId, entry);
  }

  #finishSession(ptySessionId: PtySessionId, entry: Entry, reason: PtyCloseReason): void {
    clearTimeout(entry.idleTimer);
    if (entry.commandTimer !== undefined) clearTimeout(entry.commandTimer);
    this.#sessions.delete(ptySessionId);
    this.#emit(entry.xmSessionId, {
      type: 'shell.session.closed',
      payload: { ptySessionId, reason, tail: entry.tail },
    });
  }

  #scheduleIdleTimeout(ptySessionId: PtySessionId): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = this.#sessions.get(ptySessionId);
      if (entry === undefined) return;
      if (entry.pty !== undefined) {
        entry.status = 'killed';
        const pty = entry.pty;
        entry.pty = undefined;
        if (entry.commandTimer !== undefined) clearTimeout(entry.commandTimer);
        entry.commandTimer = undefined;
        killProcessTree(pty.pid, this.#os);
        try {
          pty.kill();
        } catch {
          // 进程树清理可能已经先一步完成了。
        }
        this.#emit(entry.xmSessionId, {
          type: 'shell.session.command.finished',
          payload: { ptySessionId, reason: 'killed', tail: entry.tail },
        });
      }
      this.#finishSession(ptySessionId, entry, 'idle_timeout');
    }, this.#idleTimeoutMs);
    timer.unref();
    return timer;
  }

  #resetIdleTimer(ptySessionId: PtySessionId, entry: Entry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.#scheduleIdleTimeout(ptySessionId);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

const defaultSpawnPty: SpawnPty = (file, args, options) =>
  ptySpawn(file, [...args], {
    name: 'xterm-color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });
