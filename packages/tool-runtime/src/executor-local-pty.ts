import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { spawn as spawnPty } from 'node-pty';
import type { ExecutionPty, ExecutionPtyInput, ExecutionPtyProcess } from '@xm/kernel';
import { killLocalProcessTree } from './executor-local-process.js';

const isFile = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isFile(); } catch { return false; }
};

const executableOf = async (input: ExecutionPtyInput): Promise<string | undefined> => {
  const [file] = input.argv;
  if (file === undefined || file === '') return undefined;
  if (input.os !== 'windows') return file;
  const source = input.envSource ?? process.env;
  const hasDirectory = file.includes('/') || file.includes('\\');
  const directories = hasDirectory
    ? [input.cwd]
    : [input.cwd, ...(source.PATH ?? source.Path ?? '').split(';')
        .map((part) => part.trim().replace(/^"|"$/gu, '')).filter(Boolean)];
  const extensions = win32.extname(file) === ''
    ? (source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = win32.isAbsolute(file)
        ? `${file}${extension}`
        : win32.resolve(directory, `${file}${extension}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
};

const envOf = (input: ExecutionPtyInput): Record<string, string> => {
  const source = input.envSource ?? process.env;
  const out: Record<string, string> = {};
  for (const key of input.inheritEnv ?? []) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const localExecutionPty = (): ExecutionPty => ({
  async spawn(input): Promise<ExecutionPtyProcess> {
    const executable = await executableOf(input);
    if (executable === undefined) throw new Error(`找不到可执行程序：${input.argv[0] ?? ''}`);
    const raw = spawnPty(executable, [...input.argv.slice(1)], {
      name: 'xterm-color', cols: input.cols, rows: input.rows,
      cwd: input.cwd, env: envOf(input),
    });
    return {
      onData: (listener) => { raw.onData(listener); },
      onExit: (listener) => { raw.onExit(({ exitCode }) => { listener(exitCode); }); },
      resize: (cols, rows) => { raw.resize(cols, rows); },
      kill: () => {
        killLocalProcessTree(raw.pid, input.os);
        try { raw.kill(); } catch { /* 已退出。 */ }
      },
    };
  },
});
