import { spawn } from 'node:child_process';
import type {
  ExecutionProcess,
  ExecutionProcessInput,
  ExecutionProcessResult,
  OsFamily,
} from '@xm/kernel';

const environmentOf = (input: ExecutionProcessInput): Record<string, string> => {
  const source = input.envSource ?? process.env;
  const out: Record<string, string> = {};
  for (const key of input.inheritEnv ?? []) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...input.env };
};

export const killLocalProcessTree = (pid: number | undefined, os: OsFamily): void => {
  if (pid === undefined) return;
  if (os === 'windows') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出。 */ }
  }, 2000);
  timer.unref();
};

export const localExecutionProcess = (): ExecutionProcess => ({
  run(input): Promise<ExecutionProcessResult> {
    return new Promise((done) => {
      const [file = '', ...args] = input.argv;
      const child = spawn(file, args, {
        cwd: input.cwd,
        env: environmentOf(input),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: input.os !== 'windows',
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let clipped = false;
      let timedOut = false;
      let interrupted = false;
      let stoppedByConsumer = false;
      let settled = false;
      const limit = input.maxOutputBytes ?? 256 * 1024;

      const collect = (chunk: Buffer, kind: 'stdout' | 'stderr'): void => {
        if (clipped || stoppedByConsumer) return;
        bytes += chunk.byteLength;
        if (bytes > limit) {
          clipped = true;
          killLocalProcessTree(child.pid, input.os);
          return;
        }
        const text = chunk.toString('utf8');
        if (kind === 'stdout') stdout += text;
        else stderr += text;
        const keep = kind === 'stdout' ? input.onStdout?.(text) : input.onStderr?.(text);
        if (keep === false) {
          stoppedByConsumer = true;
          killLocalProcessTree(child.pid, input.os);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => { collect(chunk, 'stdout'); });
      child.stderr.on('data', (chunk: Buffer) => { collect(chunk, 'stderr'); });
      const timer = setTimeout(() => {
        timedOut = true;
        killLocalProcessTree(child.pid, input.os);
      }, input.timeoutMs);
      const onAbort = (): void => {
        interrupted = true;
        killLocalProcessTree(child.pid, input.os);
      };
      input.signal.addEventListener('abort', onAbort);
      const finish = (extra: Partial<ExecutionProcessResult>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        done({
          stdout, stderr, code: undefined, signal: undefined,
          timedOut, interrupted, clipped, stoppedByConsumer, ...extra,
        });
      };
      child.on('error', (error: Error) => { finish({ spawnError: error.message }); });
      child.on('close', (code, signal) => { finish({
        code: code ?? undefined,
        signal: signal ?? undefined,
      }); });
    });
  },
});
