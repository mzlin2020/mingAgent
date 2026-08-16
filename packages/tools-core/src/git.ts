import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { OsFamily, RegisteredTool, ToolContext } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { parseCommitArgv, sameArgv, validBranchArgv, validDiffArgv } from './git-argv.js';
import { GitOutput } from './git-output.js';
import { runCommand, shellEnvironment, type RunOutcome } from './shell-exec.js';

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
  /**
   * 本工具自己的临时文件目录（Trace2 事件流落在这里）。**必填**——装配方手里一定有
   * `XmPaths`，让它传过来，忘了传就编译不过。
   *
   * 不用 `os.tmpdir()`：一是 ADR-0007 不让业务代码碰 `node:os`；二是共享临时目录是
   * 世界可写的，而这里写的是命令轨迹。更早的实现把它建在用户仓库的 `.git/` 里，
   * 那更糟——进程崩在 commit 中间会在别人的仓库内部留下 `xm-git-trace-*`（ADR-0046 补记）。
   */
  readonly tempDir: string;
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
    outputSchema: GitOutput,
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
    outputSchema: GitOutput,
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
    outputSchema: GitOutput,
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
    outputSchema: GitOutput,
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
): Promise<GitOutput> {
  const cwd = input.cwd ?? ctx.cwd;
  const status = await statusOf(cwd, options, ctx);
  const common = commonFailure(status.run, STATUS_ARGV, cwd);
  if (common !== undefined) return common;
  if (status.conflicted) return failure('conflict', input, ctx, '仓库存在未解决冲突，未提交。');

  const untracked = await runGit(
    ['git', 'ls-files', '--others', '--exclude-standard', '--', ...paths], cwd, options, ctx,
  );
  const untrackedFailure = commonFailure(untracked, input.argv, cwd);
  if (untrackedFailure !== undefined) return untrackedFailure;
  /*
   * `git commit --only -- <path>` 看不见未跟踪文件，所以要先给它们建 intent-to-add 条目。
   * 记下究竟给哪些路径建了，失败时只撤销这几条（见下面的 finally）。
   */
  const intentAdded = untracked.stdout.split(/\r?\n/u).filter(Boolean);

  let committed = false;
  try {
    if (intentAdded.length > 0) {
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

    // Trace2 的临时目录放应用自己的目录，不放用户仓库的 `.git/`（见 GitToolsOptions.tempDir）
    await ctx.executor.fs.mkdir(options.tempDir);
    const traceDir = await ctx.executor.fs.mkdtemp(ctx.executor.fs.path.join(options.tempDir, 'xm-git-trace-'));
    const tracePath = ctx.executor.fs.path.join(traceDir, 'trace.json');
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
      const hook = await failedHook(ctx, tracePath);
      return {
        ...(commonCommit ?? failure('command_failed', input, ctx, 'git commit 失败。')),
        ...(hook === undefined ? {} : { kind: 'hook_failed', hook }),
        scope,
      };
    } finally {
      await ctx.executor.fs.remove(traceDir, { recursive: true, force: true });
    }
  } finally {
    /*
     * 失败时只撤销**我们自己加的那几条** intent-to-add 条目（ADR-0046 补记）。
     *
     * 原来的做法是：commit 前把 `.git/index` 整个读成字节，失败时原样写回。三个问题——
     * 写入不原子（没有 temp+rename）、不持 `index.lock`、而且会把这期间**任何人**对索引
     * 的改动一起抹掉：用户在终端里 `git add` 的东西、pre-commit 钩子里 formatter 补的
     * `git add`，都会无声消失。小明跑在用户桌面上、用户同时开着终端和 IDE，这不是理论风险。
     * 而且那次写入完全绕开了策略链与 checkpoint，写的还是 `.git/` 下的文件。
     *
     * `git rm --cached` 走 git 自己的加锁，只动指定路径；`--ignore-unmatch` 保证条目
     * 已经不在时不报错（例如 commit 部分成功）。
     */
    if (!committed && intentAdded.length > 0) {
      await runGit(
        ['git', 'rm', '--cached', '--force', '--quiet', '--ignore-unmatch', '--', ...intentAdded],
        cwd,
        options,
        ctx,
      );
    }
  }
}

const gitResource = [{ kind: 'global' as const, name: 'git-worktree' }];

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
    process: ctx.executor.process,
    bin, args, cwd, timeoutMs: 120_000, os: options.os, signal: ctx.signal,
    ...shellEnvironment({
      os: options.os,
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      /*
       * 固定 C 语言环境（ADR-0046 补记）。
       *
       * `commonFailure()` 用英文子串 `not a git repository` 判 not_repository，而
       * `ENV_ALLOWLIST` 会把宿主的 LANG / LC_ALL 透传给子进程——装了中文 git 的机器上
       * 那句话是中文的，分类就悄悄退化成 command_failed。ADR-0046 §3 专门批评过
       * "用某一句本地化 stderr 猜测"，这里先把语言钉死，别让判据浮动。
       */
      LC_ALL: 'C',
      LANG: 'C',
      // 仓库级 core.fsmonitor 可以指向任意可执行 hook；status/diff 的“只读”语义
      // 不能依赖用户或仓库没有配置它。命令行配置环境在本次进程内覆盖仓库配置。
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      ...extraEnv,
    },
  });
}

function commonFailure(run: RunOutcome, argv: readonly string[], cwd: string): GitOutput | undefined {
  if (run.interrupted) return envelope(false, 'interrupted', argv, cwd, run);
  const output = `${run.stdout}\n${run.stderr}`;
  if (output.includes('not a git repository')) return envelope(false, 'not_repository', argv, cwd, run);
  if (run.code !== 0 || run.spawnError !== undefined || run.timedOut) return envelope(false, 'command_failed', argv, cwd, run);
  return undefined;
}

const envelope = (ok: boolean, kind: GitOutput['kind'], argv: readonly string[], cwd: string, run: RunOutcome): GitOutput => ({
  ok, kind, argv: [...argv], cwd, stdout: run.stdout, stderr: run.stderr,
  exitCode: run.code, signal: run.signal, timedOut: run.timedOut,
  ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
});

const failure = (
  kind: GitOutput['kind'],
  input: { argv: readonly string[]; cwd?: string | undefined },
  ctx: ToolContext,
  message: string,
): GitOutput => ({
  ok: false, kind, argv: [...input.argv], cwd: input.cwd ?? ctx.cwd, message, stdout: '', stderr: '',
});

async function failedHook(ctx: ToolContext, path: string): Promise<string | undefined> {
  let text: string;
  try { text = new TextDecoder().decode(await ctx.executor.fs.read(path)); } catch { return undefined; }
  const hooks = new Map<number, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === '') continue;
    // 半截 trace 行（进程被杀、缓冲没刷完）不该把整次 commit 打挂——它只是让分类退回通用失败
    let event: { event?: string; child_id?: number; child_class?: string; hook_name?: string; code?: number };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.event === 'child_start' && event.child_class === 'hook' && event.child_id !== undefined) hooks.set(event.child_id, event.hook_name ?? 'unknown');
    if (event.event === 'child_exit' && event.child_id !== undefined && event.code !== 0 && hooks.has(event.child_id)) return hooks.get(event.child_id);
  }
  return undefined;
}

const interruptedOutcome = (): RunOutcome => ({
  stdout: '', stderr: '', code: undefined, signal: undefined, timedOut: false,
  interrupted: true, clipped: false, stoppedByConsumer: false,
});
/**
 * git 的模型可见内容一直就是这个对象的 JSON——**规范值与它同源，不是第二份事实**。
 * 所以这次迁移在 git 上是零行为变化：`forModel` 一个字节没动。
 */
const jsonResult = (value: GitOutput): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text: JSON.stringify(value) }],
  output: value,
});
