import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { OsFamily, RegisteredTool, ToolContext } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { runCommand, shellChildEnv, type RunOutcome } from './shell-exec.js';

export const GIT_STATUS = 'git.status';
export const GIT_DIFF = 'git.diff';
export const GIT_BRANCH = 'git.branch';
export const GIT_COMMIT = 'git.commit';

const STATUS_ARGV = ['git', 'status', '--porcelain=v1', '--branch', '--untracked-files=all'];
const Argv = z.array(z.string()).min(2).max(300);
const Input = z.strictObject({ argv: Argv, cwd: z.string().optional() });
const StatusInput = z.strictObject({
  argv: Argv.default(STATUS_ARGV),
  cwd: z.string().optional(),
});

export interface GitToolsOptions {
  readonly os: OsFamily;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const gitTools = (options: GitToolsOptions): readonly RegisteredTool[] => [
  gitStatusTool(options),
  gitDiffTool(options),
  gitBranchTool(options),
  gitCommitTool(options),
];

export const gitStatusTool = (options: GitToolsOptions): RegisteredTool =>
  defineTool({
    name: GIT_STATUS,
    group: 'git',
    description: '查看本地仓库的分支和工作树状态。argv 可省略；不访问网络。',
    inputSchema: StatusInput,
    risk: 'low',
    capabilities: ['shell.exec'],
    concurrency: 'exclusive',
    commandInputs: { argv: 'argv', cwd: 'cwd' },
    resources: () => gitResource,
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (!sameArgv(input.argv, STATUS_ARGV)) {
        yield jsonResult(failure('command_failed', input, ctx, 'git.status 只接受固定的只读 argv。'));
        return;
      }
      const run = await runGit(input.argv, input.cwd ?? ctx.cwd, options, ctx);
      const common = commonFailure(run, input.argv, input.cwd ?? ctx.cwd);
      if (common !== undefined) yield jsonResult(common);
      else {
        const lines = run.stdout.split(/\r?\n/u).filter(Boolean);
        yield jsonResult({
          ok: true,
          kind: 'status',
          argv: input.argv,
          cwd: input.cwd ?? ctx.cwd,
          branch: lines[0]?.startsWith('## ') === true ? lines[0].slice(3) : '',
          entries: lines.slice(1).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
          stdout: run.stdout,
          stderr: run.stderr,
        });
      }
    },
  });

export const gitDiffTool = (options: GitToolsOptions): RegisteredTool =>
  defineTool({
    name: GIT_DIFF,
    group: 'git',
    description:
      '查看本地 diff。argv 必须包含 --no-ext-diff、--no-textconv 与 --no-color，以禁止仓库配置执行外部转换；可加 --cached、--stat 或 --name-status。',
    inputSchema: Input,
    risk: 'low',
    capabilities: ['shell.exec'],
    concurrency: 'exclusive',
    commandInputs: { argv: 'argv', cwd: 'cwd' },
    resources: () => gitResource,
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (!validDiffArgv(input.argv)) {
        yield jsonResult(failure('command_failed', input, ctx, 'git.diff 的 argv 含未允许的参数。'));
        return;
      }
      const run = await runGit(input.argv, input.cwd ?? ctx.cwd, options, ctx);
      yield jsonResult(
        commonFailure(run, input.argv, input.cwd ?? ctx.cwd) ?? {
          ok: true,
          kind: 'diff',
          argv: input.argv,
          cwd: input.cwd ?? ctx.cwd,
          stdout: run.stdout,
          stderr: run.stderr,
        },
      );
    },
  });

export const gitBranchTool = (options: GitToolsOptions): RegisteredTool =>
  defineTool({
    name: GIT_BRANCH,
    group: 'git',
    description:
      '创建或切换本地分支。只接受 ["git","switch","分支"] 或 ["git","switch","-c","分支"]。',
    inputSchema: Input,
    risk: 'medium',
    capabilities: ['shell.exec', 'git.write'],
    concurrency: 'exclusive',
    commandInputs: { argv: 'argv', cwd: 'cwd' },
    resources: () => gitResource,
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      if (!validBranchArgv(input.argv)) {
        yield jsonResult(failure('command_failed', input, ctx, 'git.branch 的 argv 不是受支持的 switch 形状。'));
        return;
      }
      const cwd = input.cwd ?? ctx.cwd;
      const status = await statusOf(cwd, options, ctx);
      const before = commonFailure(status.run, STATUS_ARGV, cwd);
      if (before !== undefined) {
        yield jsonResult(before);
        return;
      }
      if (status.conflicted) {
        yield jsonResult(failure('conflict', input, ctx, '仓库存在未解决冲突，未切换分支。'));
        return;
      }
      const run = await runGit(input.argv, cwd, options, ctx);
      yield jsonResult(
        commonFailure(run, input.argv, cwd) ?? {
          ok: true,
          kind: 'branch',
          argv: input.argv,
          cwd,
          stdout: run.stdout,
          stderr: run.stderr,
        },
      );
    },
  });

export const gitCommitTool = (options: GitToolsOptions): RegisteredTool =>
  defineTool({
    name: GIT_COMMIT,
    group: 'git',
    description:
      '只提交显式路径。argv 必须是 ["git","commit","--only","-m","消息","--","path",...]；其它已暂存或修改文件不会夹带。',
    inputSchema: Input,
    risk: 'medium',
    capabilities: ['shell.exec', 'git.write'],
    concurrency: 'exclusive',
    commandInputs: { argv: 'argv', cwd: 'cwd' },
    resources: () => gitResource,
    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const parsed = parseCommitArgv(input.argv);
      if (parsed === undefined) {
        yield jsonResult(failure('command_failed', input, ctx, 'git.commit 必须使用 --only、-m 和显式路径。'));
        return;
      }
      yield jsonResult(await commit(input, parsed.paths, options, ctx));
    },
  });

async function commit(
  input: z.infer<typeof Input>,
  paths: readonly string[],
  options: GitToolsOptions,
  ctx: ToolContext,
): Promise<Readonly<Record<string, unknown>>> {
  const cwd = input.cwd ?? ctx.cwd;
  const status = await statusOf(cwd, options, ctx);
  const common = commonFailure(status.run, STATUS_ARGV, cwd);
  if (common !== undefined) return common;
  if (status.conflicted) return failure('conflict', input, ctx, '仓库存在未解决冲突，未提交。');

  const indexPath = await gitPath('index', cwd, options, ctx);
  if (indexPath === undefined) return failure('command_failed', input, ctx, '无法定位 Git index。');
  const originalIndex = await readOptional(indexPath);
  const untracked = await runGit(
    ['git', 'ls-files', '--others', '--exclude-standard', '--', ...paths], cwd, options, ctx,
  );
  const untrackedFailure = commonFailure(untracked, input.argv, cwd);
  if (untrackedFailure !== undefined) return untrackedFailure;

  let committed = false;
  try {
    if (untracked.stdout.trim() !== '') {
      const intent = await runGit(['git', 'add', '--intent-to-add', '--', ...paths], cwd, options, ctx);
      const intentFailure = commonFailure(intent, input.argv, cwd);
      if (intentFailure !== undefined) return intentFailure;
    }
    const scopeRun = await runGit(
      ['git', 'diff', '--name-status', '--ita-visible-in-index', 'HEAD', '--', ...paths],
      cwd,
      options,
      ctx,
    );
    const scopeFailure = commonFailure(scopeRun, input.argv, cwd);
    if (scopeFailure !== undefined) return scopeFailure;
    const scope = scopeRun.stdout.split(/\r?\n/u).filter(Boolean);
    if (scope.length === 0) return failure('empty_commit', input, ctx, '所列路径没有可提交改动。');

    const traceDir = await mkdtemp(join(dirname(indexPath), 'xm-git-trace-'));
    const tracePath = join(traceDir, 'trace.json');
    try {
      const run = await runGit(input.argv, cwd, options, ctx, { GIT_TRACE2_EVENT: tracePath });
      if (run.code === 0) {
        committed = true;
        return {
          ok: true, kind: 'commit', argv: input.argv, cwd, scope,
          stdout: run.stdout, stderr: run.stderr,
        };
      }
      const commonCommit = commonFailure(run, input.argv, cwd);
      if (commonCommit?.kind === 'interrupted') return commonCommit;
      const hook = await failedHook(tracePath);
      return {
        ...(commonCommit ?? failure('command_failed', input, ctx, 'git commit 失败。')),
        ...(hook === undefined ? {} : { kind: 'hook_failed', hook }),
        scope,
      };
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  } finally {
    if (!committed) await restoreIndex(indexPath, originalIndex);
  }
}

const gitResource = [{ kind: 'global' as const, name: 'git-worktree' }];

function validDiffArgv(argv: readonly string[]): boolean {
  if (argv[0] !== 'git' || argv[1] !== 'diff') return false;
  const divider = argv.indexOf('--');
  const flags = argv.slice(2, divider === -1 ? undefined : divider);
  const allowed = new Set([
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--cached',
    '--stat',
    '--name-status',
  ]);
  const required = ['--no-ext-diff', '--no-textconv', '--no-color'];
  return required.every((flag) => flags.includes(flag)) &&
    flags.every((flag) => allowed.has(flag)) &&
    (divider === -1 || argv.slice(divider + 1).every((path) => path !== '' && !path.startsWith('-')));
}

function validBranchArgv(argv: readonly string[]): boolean {
  const branch = argv.at(-1) ?? '';
  return argv[0] === 'git' && argv[1] === 'switch' &&
    (argv.length === 3 || (argv.length === 4 && argv[2] === '-c')) &&
    branch !== '' && !branch.startsWith('-');
}

function parseCommitArgv(argv: readonly string[]): { paths: readonly string[] } | undefined {
  if (argv.length < 7 || argv[0] !== 'git' || argv[1] !== 'commit' || argv[2] !== '--only' ||
      argv[3] !== '-m' || argv[4] === '') return undefined;
  const divider = argv.indexOf('--', 5);
  const paths = divider === 5 ? argv.slice(6) : [];
  return paths.length > 0 && paths.every((path) => path !== '' && !path.startsWith('-')) ? { paths } : undefined;
}

async function statusOf(cwd: string, options: GitToolsOptions, ctx: ToolContext): Promise<{ run: RunOutcome; conflicted: boolean }> {
  const run = await runGit(STATUS_ARGV, cwd, options, ctx);
  const conflicted = run.stdout.split(/\r?\n/u).slice(1).some((line) => {
    const code = line.slice(0, 2);
    return code.includes('U') || code === 'AA' || code === 'DD';
  });
  return { run, conflicted };
}

async function runGit(
  argv: readonly string[], cwd: string, options: GitToolsOptions, ctx: ToolContext,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunOutcome> {
  if (ctx.signal.aborted) return interruptedOutcome();
  const [bin = '', ...args] = argv;
  return runCommand({
    bin, args, cwd, timeoutMs: 120_000, os: options.os, signal: ctx.signal,
    env: {
      ...shellChildEnv({
        os: options.os,
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      // 仓库级 core.fsmonitor 可以指向任意可执行 hook；status/diff 的“只读”语义
      // 不能依赖用户或仓库没有配置它。命令行配置环境在本次进程内覆盖仓库配置。
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      ...extraEnv,
    },
  });
}

function commonFailure(run: RunOutcome, argv: readonly string[], cwd: string): Readonly<Record<string, unknown>> | undefined {
  if (run.interrupted) return envelope(false, 'interrupted', argv, cwd, run);
  const output = `${run.stdout}\n${run.stderr}`;
  if (output.includes('not a git repository')) return envelope(false, 'not_repository', argv, cwd, run);
  if (run.code !== 0 || run.spawnError !== undefined || run.timedOut) return envelope(false, 'command_failed', argv, cwd, run);
  return undefined;
}

const envelope = (ok: boolean, kind: string, argv: readonly string[], cwd: string, run: RunOutcome): Readonly<Record<string, unknown>> => ({
  ok, kind, argv, cwd, stdout: run.stdout, stderr: run.stderr,
  exitCode: run.code, signal: run.signal, timedOut: run.timedOut,
  ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
});

const failure = (
  kind: string,
  input: { argv: readonly string[]; cwd?: string | undefined },
  ctx: ToolContext,
  message: string,
): Readonly<Record<string, unknown>> => ({
  ok: false, kind, argv: input.argv, cwd: input.cwd ?? ctx.cwd, message, stdout: '', stderr: '',
});

async function gitPath(name: string, cwd: string, options: GitToolsOptions, ctx: ToolContext): Promise<string | undefined> {
  const run = await runGit(['git', 'rev-parse', '--git-path', name], cwd, options, ctx);
  return run.code === 0 ? resolve(cwd, run.stdout.trim()) : undefined;
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restoreIndex(path: string, bytes: Uint8Array | undefined): Promise<void> {
  if (bytes === undefined) await rm(path, { force: true });
  else await writeFile(path, bytes);
}

async function failedHook(path: string): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return undefined; }
  const hooks = new Map<number, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === '') continue;
    const event = JSON.parse(line) as { event?: string; child_id?: number; child_class?: string; hook_name?: string; code?: number };
    if (event.event === 'child_start' && event.child_class === 'hook' && event.child_id !== undefined) hooks.set(event.child_id, event.hook_name ?? 'unknown');
    if (event.event === 'child_exit' && event.child_id !== undefined && event.code !== 0 && hooks.has(event.child_id)) return hooks.get(event.child_id);
  }
  return undefined;
}

const sameArgv = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const interruptedOutcome = (): RunOutcome => ({ stdout: '', stderr: '', code: undefined, signal: undefined, timedOut: false, interrupted: true, clipped: false });
const jsonResult = (value: unknown): ToolProgress => ({ kind: 'result', forModel: [{ type: 'text', text: JSON.stringify(value) }] });
