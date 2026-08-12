import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { OsFamily } from '@xm/kernel';

interface ResolvePtyExecutableOptions {
  readonly os: OsFamily;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isFile?: (path: string) => boolean;
}

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * node-pty 在 Windows 上不会按 PATHEXT 补 `.exe`，所以 `node`、`cmd` 这类正常 argv
 * 会在进入 ConPTY 前得到 `File not found`。在我们自己的白名单环境里先解析成绝对路径，
 * 也让 node-pty 不再依赖父进程的 Path。
 */
export function resolvePtyExecutable(
  file: string,
  options: ResolvePtyExecutableOptions,
): string | undefined {
  if (options.os !== 'windows') return file;

  const isFile = options.isFile ?? isRegularFile;
  const hasDirectory = file.includes('/') || file.includes('\\');
  const directories = hasDirectory
    ? [options.cwd]
    : [
        options.cwd,
        ...(options.env.PATH ?? options.env.Path ?? '')
          .split(';')
          .map((part) => part.trim().replace(/^"|"$/g, ''))
          .filter((part) => part !== ''),
      ];
  const extensions = win32.extname(file) === ''
    ? (options.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
    : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = win32.isAbsolute(file)
        ? `${file}${extension}`
        : win32.resolve(directory, `${file}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
