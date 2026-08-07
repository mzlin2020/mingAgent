import type { TargetNormalization } from './target.js';

/**
 * 命令行目标的规范化 —— ADR-0020 决策三欠下的那半张契约。
 *
 * ── 在这个文件存在之前 ──
 *
 * `normalize.ts` 的 `command` 分支是一句失败关闭：带非空 target 的命令类判定一律判不了。
 * 那道闸门当时是对的（没有任何 shell 工具能喂它，写出来就是再造一个"测试全绿、
 * 真实输入下从未跑过"的东西），而它的存在也确实逼出了这个文件：`shell.exec` 落地时
 * 绕不过去，只能来把契约补上。
 *
 * ── 这个文件负责什么、不负责什么 ──
 *
 * 负责：把一条命令变成**一个稳定的字符串**，使得同一条命令的不同写法得到同一个串。
 *   · `argv[0]` 取 basename —— `/bin/rm` 与 `rm` 是同一个程序
 *   · 参数之间恒为单个空格 —— `rm  -rf /`（双空格）与 `rm -rf /` 是同一条命令
 *   · 需要引号的参数按**唯一一种**写法加引号 —— 于是规范化是幂等的，
 *     而幂等正是"判定看到的串"与"事件里记的串"能对上的前提
 *
 * **不负责**：判断这条命令危不危险。那件事由 `command-claims.ts` 把命令拆成一组
 * `{能力, 目标}` 主张之后，交给已经存在的路径 / 主机规则去判——包括红线。
 * 这条分工是本段的全部要害：`rm -rf ~` 之所以被拦，不是因为有人写了一条匹配
 * "rm -rf ~" 的规则（那种规则挡不住任何一种等价写法），而是因为它产出了一条
 * `fs.delete /home/ming` 的主张，撞上了一条早就存在的红线。
 *
 * ── 词法器为什么是"解析不了就拒"，而不是"解析不了就 ask" ──
 *
 * 这里能解析的构造，全都是**展开结果与运行时环境无关**的：引号、管道、重定向、
 * `&&`/`||`/`;`。拒掉的那些恰恰相反——`$(...)`、`` ` ``、`$VAR`、通配符——
 * 它们的展开结果取决于执行那一刻的环境，于是**判定看到的和真正执行的会是两个东西**。
 * 这正是 ADR-0012 ①、ADR-0018、ADR-0020 三次栽的同一个坑。
 *
 * 而 ask 不是安全的兜底：ask 的下一步是用户点"允许"。M1-d 的 DoD 要求
 * `rm -rf /`、`rm  -rf /`、`/bin/rm -rf /`、`sh -c 'rm -rf /'` 四种写法**判定一致**，
 * 只要最后一种落成 ask，这条 DoD 就是假的。
 */

/** 一条命令的一段（管道 / `;` / `&&` 之间的一段） */
export interface CommandSegment {
  /** 原样的 argv，未 basename、未展开。`argv[0]` 必然存在（空段在解析期就被拒了） */
  readonly argv: readonly string[];
  readonly redirects: readonly CommandRedirect[];
}

export interface CommandRedirect {
  /** `>` 与 `>>` 都是写，`<` 是读。区分它们没有意义，判定只关心能力 */
  readonly mode: 'write' | 'read';
  readonly path: string;
}

export type CommandParse =
  | { readonly ok: true; readonly segments: readonly CommandSegment[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析一段 **shell 源码**（`sh -c` 后面那个字符串，或本文件自己产出的规范形式）。
 *
 * ⚠️ 只用在真的有 shell 语义的地方。`shell.exec` 收到的 `argv` 数组**不经过这里**——
 * 那里的每个元素已经是字面量，再拿 shell 语义去解一遍就是无中生有：
 * 一个内容是 `*.ts` 的参数在 argv 里是文件名，在 shell 源码里是通配符。
 */
export function parseShellSource(source: string): CommandParse {
  const segments: CommandSegment[] = [];
  let argv: string[] = [];
  const redirects: CommandRedirect[] = [];
  /** 下一个词是重定向的目标时，记着是哪一种 */
  let pendingRedirect: 'write' | 'read' | undefined;

  const flush = (): CommandParse | undefined => {
    if (argv.length === 0) {
      return { ok: false, reason: `命令 "${source}" 里有一段是空的（多余的 | 或 ;）。` };
    }
    segments.push({ argv, redirects: [...redirects] });
    argv = [];
    redirects.length = 0;
    return undefined;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';

    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // 换行与 `;` 同义：一条接一条
    if (ch === '\n' || ch === ';') {
      const bad = flush();
      if (bad !== undefined) return bad;
      i++;
      continue;
    }

    if (ch === '|' || ch === '&') {
      const doubled = source[i + 1] === ch;
      if (ch === '&' && !doubled) {
        return {
          ok: false,
          reason:
            `命令 "${source}" 里有后台运行符 "&"。放进后台的进程会脱离本次调用的生命周期，` +
            `中断与超时都管不到它，因此这里不解析。`,
        };
      }
      const bad = flush();
      if (bad !== undefined) return bad;
      i += doubled ? 2 : 1;
      continue;
    }

    if (ch === '<' || ch === '>') {
      if (source[i + 1] === ch) {
        // `<<` 是 heredoc（后面跟着的是一整块内联文本，判不了）；`>>` 是追加写
        if (ch === '<') {
          return { ok: false, reason: `命令 "${source}" 里有 heredoc（<<），它的内容判不了。` };
        }
        pendingRedirect = 'write';
        i += 2;
        continue;
      }
      if (source[i + 1] === '&') {
        return {
          ok: false,
          reason: `命令 "${source}" 里有文件描述符重定向（>&），它指向的不是一个可判定的路径。`,
        };
      }
      pendingRedirect = ch === '>' ? 'write' : 'read';
      i++;
      continue;
    }

    const word = readWord(source, i);
    if (!word.ok) return { ok: false, reason: word.reason };
    i = word.next;

    if (pendingRedirect !== undefined) {
      redirects.push({ mode: pendingRedirect, path: word.value });
      pendingRedirect = undefined;
      continue;
    }
    argv.push(word.value);
  }

  if (pendingRedirect !== undefined) {
    return { ok: false, reason: `命令 "${source}" 的重定向符后面没有目标。` };
  }
  if (argv.length === 0 && segments.length === 0) {
    return { ok: false, reason: '命令为空。' };
  }
  // 结尾的 `;` 让 argv 为空，这不是错误
  if (argv.length > 0) {
    const bad = flush();
    if (bad !== undefined) return bad;
  }

  return { ok: true, segments };
}

type WordRead =
  | { readonly ok: true; readonly value: string; readonly next: number }
  | { readonly ok: false; readonly reason: string };

/**
 * 读一个词。**能读的构造是白名单，其余一律拒**。
 *
 * 白名单：裸字符、`'...'`（完全字面）、`"..."`（只允许 `\` 转义 `" \ $` 与反引号）、
 * 词外的 `\x` 转义。
 *
 * 黑名单每一条都对应一种"展开结果取决于运行时环境"的构造，理由见文件头。
 */
function readWord(source: string, start: number): WordRead {
  let out = '';
  let i = start;
  let quoted = false;

  while (i < source.length) {
    const ch = source[i] ?? '';

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '|' || ch === '&') break;
    if (ch === '<' || ch === '>') break;

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined || next === '\n') {
        return { ok: false, reason: `命令里有一个悬空的反斜杠。` };
      }
      out += next;
      quoted = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) return { ok: false, reason: `命令里有没有闭合的单引号。` };
      out += source.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      const read = readDoubleQuoted(source, i);
      if (!read.ok) return read;
      out += read.value;
      quoted = true;
      i = read.next;
      continue;
    }

    const rejected = rejectionFor(ch, out === '' && !quoted, source, i);
    if (rejected !== undefined) return { ok: false, reason: rejected };

    out += ch;
    i++;
  }

  if (out === '' && !quoted) {
    return { ok: false, reason: `命令里有一个空词。` };
  }
  return { ok: true, value: out, next: i };
}

function readDoubleQuoted(source: string, start: number): WordRead {
  let out = '';
  let i = start + 1;

  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === '"') return { ok: true, value: out, next: i + 1 };

    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next !== '"' && next !== '\\' && next !== '$' && next !== '`') {
        return {
          ok: false,
          reason: `双引号里有一个不认识的转义 "\\${next}"。不同 shell 对它的处理不一样，因此不解析。`,
        };
      }
      out += next;
      i += 2;
      continue;
    }

    if (ch === '$' || ch === '`') {
      return {
        ok: false,
        reason:
          `双引号里有 "${ch}"，它会在执行那一刻做变量替换或命令替换——` +
          `判定看到的和真正执行的会是两个东西，因此这里不解析。`,
      };
    }

    out += ch;
    i++;
  }
  return { ok: false, reason: `命令里有没有闭合的双引号。` };
}

/** 裸字符里不能出现的东西。每一条都拒得有具体理由，不是洁癖 */
function rejectionFor(ch: string, atWordStart: boolean, source: string, at: number): string | undefined {
  if (ch === '$' || ch === '`') {
    return (
      `命令 "${source}" 里有 "${ch}"：变量替换与命令替换的结果取决于执行那一刻的环境，` +
      `判定看到的和真正执行的会是两个东西。把值直接写进命令里即可。`
    );
  }
  if (ch === '*' || ch === '?' || ch === '[') {
    return (
      `命令 "${source}" 里有通配符 "${ch}"：它展开成哪些文件取决于执行那一刻的目录内容，` +
      `因此判不出这条命令到底会动哪些文件。把文件名写全，或者改用 fs.list 先看一眼。`
    );
  }
  if (ch === '(' || ch === ')') {
    return `命令 "${source}" 里有子 shell（括号）。子 shell 里的东西这里判不了。`;
  }
  if (ch === '{' || ch === '}') {
    return `命令 "${source}" 里有花括号展开。它会展开成多个词，判定看到的是展开前的样子。`;
  }
  if (ch === '~' && atWordStart) {
    // 词首的 `~/` 与 `~` 由网关按家目录展开（它有文件系统，内核没有）；`~user` 谁也解不了
    const next = source[at + 1];
    if (next !== undefined && next !== '/' && next !== ' ' && next !== '\t') {
      return `命令 "${source}" 里有 "~${next}…" 形式的家目录引用，解析它需要知道别的用户的家目录在哪。`;
    }
  }
  return undefined;
}

// ── 规范形式 ────────────────────────────────────────────────────

/** 不需要引号的字符。范围刻意窄：宁可多加一对引号，也不要两种写法得到两个串 */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * 把一个参数写成**唯一一种**形式。
 *
 * 幂等是硬要求：`quoteArg` 的输出再被 `parseShellSource` 读一遍，必须还原成同一个值。
 * 否则事件里记的串、授权里存的串、规则里匹配的串会是三个东西——
 * 「本会话都允许」下一次照样弹框，而没有任何地方看得出为什么（ADR-0024 的同一个教训）。
 */
export function quoteArg(arg: string): string {
  if (arg !== '' && BARE_WORD.test(arg)) return arg;
  if (!arg.includes("'")) return `'${arg}'`;
  // 含单引号的只能走双引号，并把双引号里有特殊含义的四个字符转义掉
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * `argv[0]` 取 basename —— `/bin/rm`、`/usr/bin/rm`、`rm` 归到同一个串。
 *
 * 内核不许用 `node:path`（零 I/O、零 node 内置），所以自己切。两种分隔符都切：
 * 判定不知道自己跑在哪个平台，而 `C:\Windows\System32\cmd.exe` 与
 * `/usr/bin/rm` 会出现在同一份规则里。
 */
export function commandBasename(bin: string): string {
  const cut = Math.max(bin.lastIndexOf('/'), bin.lastIndexOf('\\'));
  const base = cut === -1 ? bin : bin.slice(cut + 1);
  return base === '' ? bin : base;
}

/** 一段的规范形式：`rm -rf /work/x` */
export function canonicalizeSegment(segment: CommandSegment): string {
  const [bin, ...rest] = segment.argv;
  const head = quoteArg(commandBasename(bin ?? ''));
  const args = rest.map(quoteArg);
  const redirects = segment.redirects.map(
    (r) => `${r.mode === 'write' ? '>' : '<'} ${quoteArg(r.path)}`,
  );
  return [head, ...args, ...redirects].join(' ');
}

/** 整条命令的规范形式。多段之间恒用 ` | `——段与段的实际连接符不影响判定 */
export const canonicalizeSegments = (segments: readonly CommandSegment[]): string =>
  segments.map(canonicalizeSegment).join(' | ');

/** 从一个 argv 数组（没有 shell 参与）直接得到规范形式 */
export const canonicalizeArgv = (argv: readonly string[]): string =>
  canonicalizeSegment({ argv, redirects: [] });

/**
 * `PermissionRequest.target` 的命令分支。
 *
 * 空串照旧放行：它表示"这次请求没有 target"，只由能力级规则判定（`def.shell-exec`）。
 * 非空则必须解析得开并归到规范形式——**判不了就 deny**，与路径、主机两种语义一致。
 */
export function normalizeCommandTarget(raw: string): TargetNormalization {
  if (raw === '') return { ok: true, value: '' };
  if (raw.includes('\0')) return { ok: false, reason: '命令行含空字节' };

  const parsed = parseShellSource(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `${parsed.reason}判不出这条命令会做什么，因此不放行（ADR-0026）。`,
    };
  }
  return { ok: true, value: canonicalizeSegments(parsed.segments) };
}
