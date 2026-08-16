/**
 * 四个 git 工具的 **argv 形状校验**。
 *
 * 从 `git.ts` 拆出来是规模纪律逼的（那个文件因为多了一份 `outputSchema` 越过 400 行），
 * 但拆得动是因为这几个函数本来就自成一体：**纯函数、只看词、不碰进程**。
 *
 * 它们是这几个工具"只做受支持的那几件事"的唯一依据——`git.diff` 必须带
 * `--no-ext-diff` / `--no-textconv`，为的是不让仓库配置里的外部转换程序被跑起来；
 * `git.commit` 必须 `--only` 加显式路径，为的是不夹带别处已暂存的改动。
 * 改这里之前先想清楚放开的那个词能让 git 做什么。
 */

export function validDiffArgv(argv: readonly string[]): boolean {
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

export function validBranchArgv(argv: readonly string[]): boolean {
  const branch = argv.at(-1) ?? '';
  return argv[0] === 'git' && argv[1] === 'switch' &&
    (argv.length === 3 || (argv.length === 4 && argv[2] === '-c')) &&
    branch !== '' && !branch.startsWith('-');
}

export function parseCommitArgv(argv: readonly string[]): { paths: readonly string[] } | undefined {
  if (argv.length < 7 || argv[0] !== 'git' || argv[1] !== 'commit' || argv[2] !== '--only' ||
      argv[3] !== '-m' || argv[4] === '') return undefined;
  const divider = argv.indexOf('--', 5);
  const paths = divider === 5 ? argv.slice(6) : [];
  return paths.length > 0 && paths.every((path) => path !== '' && !path.startsWith('-')) ? { paths } : undefined;
}

export const sameArgv = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

