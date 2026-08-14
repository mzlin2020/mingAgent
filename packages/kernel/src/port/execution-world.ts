import type { OsFamily } from './platform.js';
import type { AbortLike } from './abort.js';

export type ExecutionWorldKind = 'local' | 'container' | 'remote';

export interface ExecutionWorldCapabilities {
  readonly filesystem: boolean;
  readonly process: boolean;
  readonly pty: boolean;
}

export interface ExecutionStat {
  readonly size: number;
  readonly file: boolean;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

export interface ExecutionDirectoryEntry {
  readonly name: string;
  readonly file: boolean;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

export interface ExecutionPath {
  dirname(path: string): string;
  join(...parts: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: readonly string[]): string;
  isAbsolute(path: string): boolean;
}

export interface ExecutionFileSystem {
  stat(path: string): Promise<ExecutionStat>;
  realpath(path: string): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  readChunks(path: string, chunkBytes?: number): AsyncIterable<Uint8Array>;
  list(path: string): Promise<readonly ExecutionDirectoryEntry[]>;
  mkdir(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  remove(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  writeTextAtomic(path: string, content: string): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
  readonly path: ExecutionPath;
}

export interface ExecutionProcessInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortLike;
  readonly os: OsFamily;
  readonly inheritEnv?: readonly string[];
  readonly envSource?: Readonly<Record<string, string | undefined>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly onStdout?: (chunk: string) => unknown;
  readonly onStderr?: (chunk: string) => unknown;
}

export interface ExecutionProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | undefined;
  readonly signal: string | undefined;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly clipped: boolean;
  readonly stoppedByConsumer: boolean;
  readonly spawnError?: string;
}

export interface ExecutionProcess {
  run(input: ExecutionProcessInput): Promise<ExecutionProcessResult>;
}

export interface ExecutionPtyProcess {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface ExecutionPtyInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly os: OsFamily;
  readonly inheritEnv?: readonly string[];
  readonly envSource?: Readonly<Record<string, string | undefined>>;
}

export interface ExecutionPty {
  spawn(input: ExecutionPtyInput): Promise<ExecutionPtyProcess>;
}

/**
 * 一组共享同一命名空间与进程边界的底层能力（ADR-0054）。
 * 工具只能经这个接缝访问文件、进程与 PTY；provider 不得重新解析网关回写的路径。
 */
export interface ExecutionWorld {
  readonly kind: ExecutionWorldKind;
  readonly capabilities: ExecutionWorldCapabilities;
  readonly fs: ExecutionFileSystem;
  readonly process: ExecutionProcess;
  readonly pty: ExecutionPty;
}
