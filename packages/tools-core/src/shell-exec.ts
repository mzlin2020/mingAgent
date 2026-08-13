import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ResultBlock, ToolProgress } from '@xm/contracts';
import type { OsFamily, RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const SHELL_EXEC = 'shell.exec';

/**
 * 跑一条命令。
 *
 * ── 入参是 argv 数组，**没有** `command: string` ──
 *
 * 接受一整条命令串，就等于把"这条命令到底分成几个词"这个问题留给某一层去猜，
 * 而那正是命令行判定所有麻烦的源头（ADR-0020 背景里那张八行的绕过表是它的网络版）。
 * 数组是唯一没有歧义的表达，而且它天然与 `spawn` 的形状一致。
 *
 * ── 永远不经过 shell ──
 *
 * `spawn(bin, args, { shell: false })`。这是 argv 契约唯一的**结构性**依据：
 * 只要不经过 shell，`argv` 的每个元素就是字面量，没有任何东西会在执行那一刻
 * 再展开一次——判定看到的和真正跑的是同一组词。
 *
 * 要用管道、重定向的时候，模型仍然可以写 `sh -c "…"`，那条路是通的，
 * 只是内层那个字符串会被内核的词法器拆开、逐段拆出主张（ADR-0026）；
 * 拆不开的构造（`$(...)`、通配符）直接判不了，而不是降级成一个确认框。
 *
 * ── 进程级的硬约束（docs/09 C2 定案的兑现物）──
 *
 * C2 定的是"不强制沙箱"。那就必须把"不强制"与"什么都不做"区分开——下面这几条
 * 全都是真的、可测的，而且每一条都对应一种具体的失控方式：
 *
 *   · **env 白名单**：不白名单，`sh -c 'echo $XM_API_KEY'` 就能读出小明自己的密钥。
 *     `env.read` 那条无条件 allow 的规则（ADR-0025 遗留）正是在这一刻活过来的。
 *   · **stdin 接 /dev/null**：继承 stdin 的话，一条等输入的命令会永远挂在那里。
 *   · **超时 + 按进程组 kill**：只 kill 直接子进程，它派生的孙进程会活下来——
 *     "点了停止但东西还在跑"比不能停更糟，因为用户以为已经停了。
 *   · **输出上限**：一条 `find /` 能吐几百 MB。截断在运行时还有一道，
 *     但那道发生在**已经付过内存代价之后**（与 `fs.read` 按行流式读同一个理由）。
 */
const Input = z.strictObject({
  argv: z
    .array(z.string())
    .min(1)
    .describe('命令与它的参数，一个词一个元素。例如 ["git", "status", "--short"]。不要写成一整条命令串'),
  cwd: z.string().optional().describe('在哪个目录下执行。默认是会话的工作目录'),
  timeoutMs: z.number().int().positive().optional().describe('超时毫秒数，默认 120000'),
});

const DEFAULT_TIMEOUT_MS = 120_000;
/** 输出上限。超过就停止收集并在结果里说明——悄悄截断与悄悄省略是同一类错误 */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * 允许透传给子进程的环境变量。
 *
 * **白名单而不是黑名单**：黑名单要求我们列全所有敏感变量名，而下一个密钥叫什么
 * 谁也不知道。白名单漏掉一个的代价是某条命令行为异常（看得见、可修复），
 * 黑名单漏掉一个的代价是密钥流进了子进程（看不见）。
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  // Windows 上没有这些就几乎什么都跑不起来
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

export interface ShellExecOptions {
  /**
   * 跑在哪个系统上。**必填，不猜**（ADR-0007：禁 `process.platform`，
   * 平台差异一律由 `PlatformPort` 显式传进来）。
   *
   * 这里它决定的是"怎么杀掉一棵进程树"——POSIX 靠进程组，Windows 只能靠
   * `taskkill /T`。猜错的后果不是报错，是**孙进程杀不掉而没人发现**：
   * 用户点了停止，界面显示已停止，东西还在跑。
   */
  readonly os: OsFamily;
  /** 追加到白名单的变量名。用户配置里显式写下的才进来 */
  readonly extraEnv?: readonly string[];
  /** 读环境变量的入口。留成参数是为了让用例能喂一个假的进去 */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const shellExecTool = (options: ShellExecOptions): RegisteredTool =>
  defineTool({
    name: SHELL_EXEC,
    group: 'shell',
    description:
      '执行一条命令并返回它的输出。argv 要一个词一个元素地写；' +
      '需要管道或重定向时写成 ["sh", "-c", "…"]，但里面不能有变量替换、命令替换或通配符。',
    inputSchema: Input,
    risk: 'medium',
    capabilities: ['shell.exec'],
    concurrency: 'exclusive',
    commandInputs: { argv: 'argv', cwd: 'cwd' },
    resources: (input) => [{ kind: 'path', mode: 'write', glob: input.cwd ?? '.' }],

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (ctx.signal.aborted) {
        yield result(`没有执行：本轮已被中断。`);
        return;
      }

      const [bin = '', ...args] = input.argv;
      const run = await runCommand({
        bin,
        args,
        cwd: input.cwd ?? ctx.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: shellChildEnv(options),
        os: options.os,
        signal: ctx.signal,
      });

      if (run.spawnError !== undefined) {
        yield result(`没能启动 ${bin}：${run.spawnError}`);
        return;
      }

      yield result(describe(bin, run));
    },
  });

/** 子进程能看到的环境。白名单之外的一律不给 */
export function shellChildEnv(options: ShellExecOptions): Record<string, string> {
  const source = options.env ?? process.env;
  const allowed = [...ENV_ALLOWLIST, ...(options.extraEnv ?? [])];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface RunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | undefined;
  readonly signal: string | undefined;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly clipped: boolean;
  readonly spawnError?: string;
}

export interface RunInput {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Record<string, string>;
  readonly os: OsFamily;
  readonly signal: { readonly aborted: boolean; addEventListener(t: 'abort', l: () => void): void; removeEventListener(t: 'abort', l: () => void): void };
}

export function runCommand(input: RunInput): Promise<RunOutcome> {
  return new Promise<RunOutcome>((done) => {
    const child = spawn(input.bin, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      // stdin 不继承：等输入的命令会永远挂着，而它挂住的是整个 Turn
      stdio: ['ignore', 'pipe', 'pipe'],
      /*
       * 自成进程组。杀的时候杀整组——只杀直接子进程的话，它派生的孙进程会活下来，
       * 而用户看到的是"已经停了"。Windows 没有进程组，那里靠 taskkill /T（见 killTree）。
       */
      detached: input.os !== 'windows',
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let clipped = false;
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
      if (clipped) return;
      const text = chunk.toString('utf8');
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        clipped = true;
        killProcessTree(child.pid, input.os);
        return;
      }
      if (into === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', (c: Buffer) => {
      collect(c, 'out');
    });
    child.stderr.on('data', (c: Buffer) => {
      collect(c, 'err');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, input.os);
    }, input.timeoutMs);

    const onAbort = (): void => {
      interrupted = true;
      killProcessTree(child.pid, input.os);
    };
    input.signal.addEventListener('abort', onAbort);

    const finish = (outcome: Partial<RunOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      done({
        stdout,
        stderr,
        code: undefined,
        signal: undefined,
        timedOut,
        interrupted,
        clipped,
        ...outcome,
      });
    };

    child.on('error', (e: Error) => {
      finish({ spawnError: e.message });
    });
    child.on('close', (code, signal) => {
      finish({
        code: code ?? undefined,
        signal: signal ?? undefined,
      });
    });
  });
}

/**
 * 杀掉整棵进程树。
 *
 * POSIX：`kill(-pid)` 打的是**进程组**，先 TERM 给一次体面退出的机会，
 * 还在就 KILL。Windows 上没有进程组，只能靠 `taskkill /T /F`。
 */
export function killProcessTree(pid: number | undefined, os: OsFamily): void {
  if (pid === undefined) return;

  if (os === 'windows') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
      /* 进程可能已经没了，这不是错误 */
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // 已经退了
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已经退了 */
    }
  }, 2000).unref();
}

/** 给模型看的结果。**退出码与 stderr 都是事实，不是异常**——它要靠这些判断下一步 */
function describe(bin: string, run: RunOutcome): string {
  const head =
    run.interrupted
      ? `${bin} 被中断（用户点了停止），已连同它派生的子进程一起结束。`
      : run.timedOut
        ? `${bin} 超时，已连同它派生的子进程一起结束。`
        : run.clipped
          ? `${bin} 的输出超过 ${String(MAX_OUTPUT_BYTES / 1024)} KB 上限，已停止并结束进程。`
          : run.signal !== undefined
            ? `${bin} 被信号 ${run.signal} 结束。`
            : `${bin} 退出码 ${String(run.code ?? -1)}。`;

  const parts = [head];
  if (run.stdout !== '') parts.push(`--- stdout ---\n${run.stdout.trimEnd()}`);
  if (run.stderr !== '') parts.push(`--- stderr ---\n${run.stderr.trimEnd()}`);
  if (run.stdout === '' && run.stderr === '') parts.push('（没有输出）');
  return parts.join('\n');
}

const result = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text } satisfies ResultBlock],
});
