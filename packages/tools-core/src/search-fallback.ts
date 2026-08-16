import type { AbortLike, ExecutionFileSystem } from '@xm/kernel';
import type { SearchHit } from './search-hit.js';

/**
 * `search.text` 在宿主没有 ripgrep 时的纯 Node 退路（ADR-0051）。
 *
 * ── 为什么需要它 ──
 *
 * M2-b 把 ripgrep 定成硬依赖，理由是"缺失时显式报错，不静默降级"。报错确实是显式的，
 * 但后果被低估了：`search.text`、`search.symbol` / `search.indexed` 的 fallback、
 * 以及工作区索引的文件枚举**全都**要 rg。普通 Windows / macOS 用户装上小明之后，
 * 整条检索能力开箱即不可用——而 M2 的目标是"日常写代码可以用它"。
 * CI 里那句 `choco install ripgrep` 只让流水线看起来是绿的。
 *
 * ── 它不假装和 ripgrep 等价 ──
 *
 * 退路只保证**同一套输出契约**（`path:line:column: 文本`）和同一批参数语义，
 * 不保证同一套忽略规则：它不读 `.gitignore`，只跳过隐藏项和一份固定的依赖/构建目录名单。
 * 结果里会标 `source: node-fallback` 并说明这点。宁可说清楚差异，也不要让调用方
 * 以为两条路径的召回集合完全一样。
 */

/** 与 ripgrep 的 `--max-columns` 对齐：超长单行跳过而不是塞进结果 */
const MAX_LINE_BYTES = 4000;
/** 单文件扫描上限。超过多半是产物或数据文件，不是要读的源码 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 判定二进制的探测长度：出现 NUL 就当二进制跳过，与 ripgrep 的默认行为一致 */
const BINARY_PROBE_BYTES = 8192;

/**
 * 不进入检索的目录名。
 *
 * 没有 `.gitignore` 就只能靠这份名单——它必须短且都是"几乎不会有人想在里面搜"的东西。
 * 隐藏目录（`.` 开头）另外统一跳过，与 ripgrep 默认不搜隐藏文件的行为一致。
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'release',
  'target',
  'vendor',
  '__pycache__',
]);

export interface FallbackSearchInput {
  readonly pattern: string;
  /** 已由能力网关规范化过的绝对路径；可以是文件也可以是目录 */
  readonly path: string;
  readonly cwd: string;
  readonly globs: readonly string[];
  readonly caseSensitive: boolean | undefined;
  readonly context: number;
  readonly maxResults: number;
  readonly signal: AbortLike;
}

export interface FallbackSearchOutcome {
  readonly hits: readonly SearchHit[];
  readonly matches: number;
  readonly limited: boolean;
  readonly interrupted: boolean;
  /** 正则本身不合法时的说明；此时不产生任何结果 */
  readonly patternError?: string;
}

export async function nodeTextSearch(
  input: FallbackSearchInput,
  fs: ExecutionFileSystem,
): Promise<FallbackSearchOutcome> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(input.pattern, smartCaseFlags(input.pattern, input.caseSensitive));
  } catch (error) {
    return {
      hits: [],
      matches: 0,
      limited: false,
      interrupted: false,
      patternError: error instanceof Error ? error.message : String(error),
    };
  }

  const globs = input.globs.map(compileGlob);
  const state: MutableOutcome = { hits: [], matches: 0, limited: false, interrupted: false };
  for await (const file of walk(fs, input.path, input.signal)) {
    if (input.signal.aborted) {
      state.interrupted = true;
      break;
    }
    if (state.limited) break;
    if (!matchesGlobs(relativeTo(fs, input.path, file), globs)) continue;
    await scanFile(fs, file, pattern, input, state);
  }
  return state;
}

interface MutableOutcome {
  hits: SearchHit[];
  matches: number;
  limited: boolean;
  interrupted: boolean;
}

/**
 * smart-case：模式里没有大写字母就忽略大小写，有就区分。
 * 与 ripgrep 默认一致，也是 `caseSensitive` 省略时用户实际预期的行为。
 */
function smartCaseFlags(pattern: string, caseSensitive: boolean | undefined): string {
  if (caseSensitive === true) return 'u';
  if (caseSensitive === false) return 'iu';
  return /[A-Z]/u.test(pattern) ? 'u' : 'iu';
}

async function* walk(fs: ExecutionFileSystem, root: string, signal: AbortLike): AsyncIterable<string> {
  let info;
  try {
    info = await fs.stat(root);
  } catch {
    return;
  }
  if (info.file) {
    yield root;
    return;
  }
  if (!info.directory) return;

  const pending = [root];
  while (pending.length > 0) {
    if (signal.aborted) return;
    const directory = pending.pop();
    if (directory === undefined) continue;
    let children;
    try {
      children = [...await fs.list(directory)];
    } catch {
      // 读不了的目录跳过而不是整体失败：一个没权限的子目录不该让整次搜索作废
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const absolute = fs.path.resolve(directory, child.name);
      // 不跟随符号链接：否则一个指回上层的链接就能让遍历打转
      if (child.symbolicLink) continue;
      if (child.directory) {
        if (!SKIP_DIRECTORIES.has(child.name)) pending.push(absolute);
      } else if (child.file) {
        yield absolute;
      }
    }
  }
}

async function scanFile(
  fs: ExecutionFileSystem,
  file: string,
  pattern: RegExp,
  input: FallbackSearchInput,
  state: MutableOutcome,
): Promise<void> {
  let info;
  try {
    info = await fs.stat(file);
  } catch {
    return;
  }
  if (info.size > MAX_FILE_BYTES) return;

  const text = await readTextFile(fs, file);
  if (text === undefined) return;

  const lines = text.split('\n');
  const shown = displayPath(fs, input.cwd, file);
  /** 行号 → column。匹配行给真实列号，上下文行给 0，不伪装成匹配（与 ripgrep 路径同一约定） */
  const selected = new Map<number, number>();
  /** 哪些行是真的命中。**不从 column 反推**——列号是不是 0 是渲染约定，不是判据 */
  const matched = new Set<number>();

  for (const [index, raw] of lines.entries()) {
    if (state.limited || input.signal.aborted) break;
    const line = stripCr(raw);
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue;
    const match = pattern.exec(line);
    if (match === null) continue;

    state.matches += 1;
    if (state.matches > input.maxResults) {
      state.matches = input.maxResults;
      state.limited = true;
      break;
    }
    for (let offset = -input.context; offset <= input.context; offset += 1) {
      const at = index + offset;
      if (at < 0 || at >= lines.length) continue;
      // 匹配行的真实列号优先：同一行先作为上下文出现过时要被覆盖回来
      if (offset === 0) {
        selected.set(at, characterColumn(line, match.index));
        matched.add(at);
      } else if (!selected.has(at)) selected.set(at, 0);
    }
  }

  for (const at of [...selected.keys()].sort((a, b) => a - b)) {
    state.hits.push({
      path: shown,
      line: at + 1,
      column: selected.get(at) ?? 0,
      text: oneLine(stripCr(lines[at] ?? '')),
      context: !matched.has(at),
    });
  }
}

/** 读成文本；二进制（含 NUL）或解码失败一律跳过，与 ripgrep 的二进制处理一致。 */
async function readTextFile(fs: ExecutionFileSystem, file: string): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let probed = false;
  try {
    for await (const buffer of fs.readChunks(file)) {
      if (!probed) {
        probed = true;
        if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return undefined;
      }
      chunks.push(buffer);
    }
  } catch {
    return undefined;
  }
  try {
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    return undefined;
  }
}

interface CompiledGlob {
  readonly negated: boolean;
  readonly matcher: RegExp;
  /** 不含 `/` 的 glob 按文件名匹配，与 ripgrep 的 `--glob` 一致 */
  readonly basenameOnly: boolean;
}

function compileGlob(glob: string): CompiledGlob {
  const negated = glob.startsWith('!');
  const body = negated ? glob.slice(1) : glob;
  return { negated, matcher: globToRegExp(body), basenameOnly: !body.includes('/') };
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` 可以匹配零层目录，所以整段一起吃掉
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/u, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

function matchesGlobs(relativePath: string, globs: readonly CompiledGlob[]): boolean {
  if (globs.length === 0) return true;
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  const test = (glob: CompiledGlob): boolean =>
    glob.matcher.test(glob.basenameOnly ? basename : relativePath);

  const positives = globs.filter((glob) => !glob.negated);
  const included = positives.length === 0 || positives.some(test);
  return included && !globs.filter((glob) => glob.negated).some(test);
}

const relativeTo = (fs: ExecutionFileSystem, root: string, file: string): string => {
  const rel = fs.path.relative(root, file);
  return (rel === '' ? file : rel).replaceAll('\\', '/');
};

const displayPath = (fs: ExecutionFileSystem, cwd: string, path: string): string => {
  const shown = fs.path.relative(cwd, path);
  return (shown === '' || shown.startsWith('..') ? path : shown).replaceAll('\\', '/');
};

const characterColumn = (line: string, index: number): number =>
  Array.from(line.slice(0, index)).length + 1;

const stripCr = (text: string): string => (text.endsWith('\r') ? text.slice(0, -1) : text);

const oneLine = (text: string): string => text.replace(/\r?\n/gu, '↵');
