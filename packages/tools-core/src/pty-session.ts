import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import { z } from 'zod';
import type { PtySessionId, ResultBlock, SessionId, ToolProgress } from '@xm/contracts';
import { newPtySessionId } from '@xm/contracts';
import type { OsFamily, RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const SHELL_SESSION_OPEN = 'shell.session.open';
export const SHELL_SESSION_WRITE = 'shell.session.write';
export const SHELL_SESSION_RESIZE = 'shell.session.resize';
export const SHELL_SESSION_CLOSE = 'shell.session.close';

/** 关闭原因，与 `ShellSessionClosedPayload.reason` 一一对应（`@xm/contracts`） */
export type PtyCloseReason = 'exited' | 'killed' | 'idle_timeout';

/**
 * `PtySessionManager` 往外推的三个事件，形状对应 `@xm/contracts` 的
 * `shell.session.opened/output/closed`（ADR-0031）。
 *
 * 不直接依赖 `@xm/contracts` 的 payload schema 类型：这里只是把事实传出去，
 * 真正的校验发生在调用方把它交给 `SessionRuntime.record()` 的那一刻——
 * 与 `dnsLookup`/`env` 那些注入点一样，manager 本身不知道、也不需要知道
 * 事件最终怎么落库。
 */
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
      readonly type: 'shell.session.output';
      readonly payload: { readonly ptySessionId: PtySessionId; readonly chunk: string };
    }
  | {
      readonly type: 'shell.session.closed';
      readonly payload: {
        readonly ptySessionId: PtySessionId;
        readonly exitCode?: number;
        readonly reason: PtyCloseReason;
        readonly tail: string;
      };
    };

/**
 * 会话已满 / 找不到会话 / 归属会话不对 —— 三种都不该 throw 到 `execute()` 外面，
 * 统一在这里收口，工具再把它转成给模型看的文字（`shell-exec.ts` 同一个姿态：
 * 失败不 throw，转成 result 里的错误内容）。
 */
export class PtySessionError extends Error {}

/** 测试注入点：真实实现是 `node-pty` 的 `spawn`，见 `PtySessionManagerOptions.spawnPty` */
export type PtyLike = Pick<IPty, 'pid' | 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>;
export type SpawnPty = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly cols: number; readonly rows: number },
) => PtyLike;

export interface PtySessionManagerOptions {
  /**
   * 跑在哪个系统上。**必填，不猜**——与 `shellExecTool` 的 `ShellExecOptions.os`
   * 同一个理由（ADR-0007：禁 `process.platform`，平台差异一律由 `PlatformPort`
   * 显式传进来）。这里它决定的是打开会话时起哪个 shell。
   */
  readonly os: OsFamily;
  /** 一次会话事件产生时调用。真实实现绑定到对应 xm 会话的 `SessionRuntime.record()` */
  readonly emit: (xmSessionId: SessionId, event: PtySessionEvent) => void;
  /** 每个 xm 会话最多同时开几个 PTY（docs/09 C7 问题 1）。默认 4 */
  readonly maxSessionsPerXmSession?: number;
  /** 无输入输出多久后自动关闭，毫秒（docs/09 C7 问题 1）。默认 30 分钟 */
  readonly idleTimeoutMs?: number;
  /** 回放尾巴的字符数上限，超出丢弃更早的内容。默认 256 KiB（字符近似字节） */
  readonly maxTailChars?: number;
  /** 测试注入：默认是真实的 `node-pty` spawn */
  readonly spawnPty?: SpawnPty;
  /** 打开会话时用哪个 shell。省略则按 `os` 选：Windows 用 powershell.exe，其余用 bash */
  readonly shell?: string;
}

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TAIL_CHARS = 256 * 1024;

interface Entry {
  readonly xmSessionId: SessionId;
  readonly pty: PtyLike;
  tail: string;
  idleTimer: ReturnType<typeof setTimeout>;
  /** 由 `close()`/空闲超时**在调用 `kill()` 之前**写入，`onExit` 读它来分辨三种关闭原因 */
  pendingReason: PtyCloseReason | undefined;
}

/**
 * PTY 会话的持有者（ADR-0031）。**不是内核端口**——它跟 `nodeToolGateway`/
 * `nodeCheckpointer` 一样，是 `packages/tools-core` 里"内核判定完之后，具体怎么做"
 * 的那一半，内核完全不知道它的存在（零 I/O 的边界不能破）。
 *
 * ── 为什么是一个共享实例，不是每个 xm 会话一份 ──
 *
 * `apps/desktop/src/main/services.ts` 里 `ToolRegistry` 是全应用共享的一份
 * （所有会话的工具定义相同），不是按会话现造。真正需要按会话隔离的是**数据**，
 * 不是工具本身——所以这里跟 `ApprovalModeStore` 走同一个形状：一个共享实例，
 * 内部按 `xmSessionId` 分区。`write`/`resize`/`close` 都要求调用方传入
 * `xmSessionId` 并核对它与会话归属一致，A 会话拿不到 B 会话开的 PTY 的句柄，
 * 即便两者共用同一个 manager 实例。
 */
export class PtySessionManager {
  readonly #sessions = new Map<PtySessionId, Entry>();
  readonly #emit: PtySessionManagerOptions['emit'];
  readonly #maxSessions: number;
  readonly #idleTimeoutMs: number;
  readonly #maxTailChars: number;
  readonly #spawnPty: SpawnPty;
  readonly #shell: string;

  constructor(options: PtySessionManagerOptions) {
    this.#emit = options.emit;
    this.#maxSessions = options.maxSessionsPerXmSession ?? DEFAULT_MAX_SESSIONS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#maxTailChars = options.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS;
    this.#spawnPty = options.spawnPty ?? defaultSpawnPty;
    this.#shell = options.shell ?? (options.os === 'windows' ? 'powershell.exe' : 'bash');
  }

  /** 当前这个 xm 会话开着几个 PTY —— 供上限检查复用，也供测试断言 */
  countFor(xmSessionId: SessionId): number {
    let n = 0;
    for (const e of this.#sessions.values()) if (e.xmSessionId === xmSessionId) n++;
    return n;
  }

  open(input: {
    readonly xmSessionId: SessionId;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }): PtySessionId {
    if (this.countFor(input.xmSessionId) >= this.#maxSessions) {
      throw new PtySessionError(
        `已经开着 ${String(this.#maxSessions)} 个终端会话，达到上限——先关掉一个再开新的。`,
      );
    }

    const ptySessionId = newPtySessionId();
    const pty = this.#spawnPty(this.#shell, [], {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
    });

    const entry: Entry = {
      xmSessionId: input.xmSessionId,
      pty,
      tail: '',
      idleTimer: this.#scheduleIdleTimeout(ptySessionId),
      pendingReason: undefined,
    };
    this.#sessions.set(ptySessionId, entry);

    pty.onData((chunk) => {
      this.#onData(ptySessionId, chunk);
    });
    pty.onExit(({ exitCode }) => {
      this.#onExit(ptySessionId, exitCode);
    });

    this.#emit(input.xmSessionId, {
      type: 'shell.session.opened',
      payload: { ptySessionId, cwd: input.cwd, cols: input.cols, rows: input.rows },
    });

    return ptySessionId;
  }

  write(xmSessionId: SessionId, ptySessionId: PtySessionId, data: string): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    entry.pty.write(data);
    this.#resetIdleTimer(ptySessionId, entry);
  }

  resize(xmSessionId: SessionId, ptySessionId: PtySessionId, cols: number, rows: number): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    entry.pty.resize(cols, rows);
  }

  close(xmSessionId: SessionId, ptySessionId: PtySessionId): void {
    const entry = this.#own(xmSessionId, ptySessionId);
    entry.pendingReason = 'killed';
    entry.pty.kill();
  }

  /** 应用退出/会话被销毁时的兜底——不等 idle timeout，直接收尾（不对外发事件：进程都要没了） */
  disposeAll(): void {
    for (const [, entry] of this.#sessions) {
      clearTimeout(entry.idleTimer);
      try {
        entry.pty.kill();
      } catch {
        /* 已经退了 */
      }
    }
    this.#sessions.clear();
  }

  #own(xmSessionId: SessionId, ptySessionId: PtySessionId): Entry {
    const entry = this.#sessions.get(ptySessionId);
    if (entry === undefined) {
      throw new PtySessionError(`会话 ${ptySessionId} 不存在或已经关闭。`);
    }
    /*
     * 归属不对**当成"不存在"处理，不单独报"这是别人的会话"**——后者会把"这个
     * ID 存在，只是不归你"这件事泄露给一个本不该知道其它会话情况的调用方。
     */
    if (entry.xmSessionId !== xmSessionId) {
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
    if (entry === undefined) return;
    clearTimeout(entry.idleTimer);
    this.#sessions.delete(ptySessionId);
    this.#emit(entry.xmSessionId, {
      type: 'shell.session.closed',
      payload: {
        ptySessionId,
        exitCode,
        reason: entry.pendingReason ?? 'exited',
        tail: entry.tail,
      },
    });
  }

  #scheduleIdleTimeout(ptySessionId: PtySessionId): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      const entry = this.#sessions.get(ptySessionId);
      if (entry === undefined) return;
      entry.pendingReason = 'idle_timeout';
      entry.pty.kill();
    }, this.#idleTimeoutMs);
    // Node 环境下别让这个计时器拖着进程不退出
    (t as { unref?: () => void }).unref?.();
    return t;
  }

  #resetIdleTimer(ptySessionId: PtySessionId, entry: Entry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.#scheduleIdleTimeout(ptySessionId);
  }
}

/** 尾巴超过上限就丢弃更早的内容，只保留最后一段——审计要看的是"结束前发生了什么" */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

const defaultSpawnPty: SpawnPty = (file, args, options) =>
  ptySpawn(file, [...args], {
    name: 'xterm-color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: process.env,
  });

// ── 四个工具 ──────────────────────────────────────────────────────

const OpenInput = z.strictObject({
  cwd: z
    .string()
    .min(1)
    .describe('在哪个目录下打开终端，可以是相对当前工作目录的（传 "." 表示当前目录）'),
  cols: z.number().int().positive().default(80).describe('终端列数，默认 80'),
  rows: z.number().int().positive().default(24).describe('终端行数，默认 24'),
});

const WriteInput = z.strictObject({
  ptySessionId: z.string().min(1).describe('shell.session.open 返回的会话 ID'),
  data: z
    .string()
    .describe('要发送给终端的原始输入，包含你希望它执行的命令。记得带上换行符 "\\n" 才会真正提交'),
});

const ResizeInput = z.strictObject({
  ptySessionId: z.string().min(1).describe('shell.session.open 返回的会话 ID'),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const CloseInput = z.strictObject({
  ptySessionId: z.string().min(1).describe('shell.session.open 返回的会话 ID'),
});

const textResult = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text } satisfies ResultBlock],
});

/**
 * 打开一个交互式终端会话。**唯一的判权点**（ADR-0031）——`write`/`resize`/`close`
 * 声明空能力集，此后完全不再判权，红线与 deny 都不覆盖会话内之后发生的事。
 */
export const shellSessionOpenTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_OPEN,
    group: 'shell',
    description:
      '打开一个交互式终端会话（PTY），适合需要持续交互、长时间运行、或全屏刷新（如 vim/top）的场景。' +
      '普通的一次性命令请用 shell.exec，不要用这个——打开后你在里面发送的所有输入不再逐条审批。' +
      '返回一个 ptySessionId，之后用 shell.session.write 发送输入、shell.session.close 结束它。',
    inputSchema: OpenInput,
    risk: 'high',
    capabilities: ['shell.session'],
    concurrency: 'exclusive',
    pathInputs: ['cwd'],
    resources: () => [{ kind: 'global', name: 'shell-session-open' }],

    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async *，manager 的方法都是同步的
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (ctx.signal.aborted) {
        yield textResult('没有打开：本轮已被中断。');
        return;
      }
      try {
        const ptySessionId = manager.open({
          xmSessionId: ctx.sessionId,
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
        });
        yield textResult(`终端会话已打开：${ptySessionId}`);
      } catch (e) {
        yield textResult(`没能打开终端会话：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

export const shellSessionWriteTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_WRITE,
    group: 'shell',
    description: '向一个已打开的终端会话发送输入。这次调用不会再次询问用户。',
    inputSchema: WriteInput,
    risk: 'medium',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],

    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async *，manager 的方法都是同步的
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      try {
        manager.write(ctx.sessionId, input.ptySessionId as PtySessionId, input.data);
        yield textResult('已发送。');
      } catch (e) {
        yield textResult(e instanceof Error ? e.message : String(e));
      }
    },
  });

export const shellSessionResizeTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_RESIZE,
    group: 'shell',
    description: '调整一个已打开终端会话的窗口大小（列数/行数）。',
    inputSchema: ResizeInput,
    risk: 'safe',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],

    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async *，manager 的方法都是同步的
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      try {
        manager.resize(ctx.sessionId, input.ptySessionId as PtySessionId, input.cols, input.rows);
        yield textResult('已调整。');
      } catch (e) {
        yield textResult(e instanceof Error ? e.message : String(e));
      }
    },
  });

export const shellSessionCloseTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_CLOSE,
    group: 'shell',
    description: '关闭一个终端会话，结束里面运行的进程。',
    inputSchema: CloseInput,
    risk: 'safe',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],

    // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async *，manager 的方法都是同步的
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      try {
        manager.close(ctx.sessionId, input.ptySessionId as PtySessionId);
        yield textResult('已关闭。');
      } catch (e) {
        yield textResult(e instanceof Error ? e.message : String(e));
      }
    },
  });

export const shellSessionTools = (manager: PtySessionManager): readonly RegisteredTool[] => [
  shellSessionOpenTool(manager),
  shellSessionWriteTool(manager),
  shellSessionResizeTool(manager),
  shellSessionCloseTool(manager),
];
