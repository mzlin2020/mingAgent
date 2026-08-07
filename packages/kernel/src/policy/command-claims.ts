import type { Capability } from '@xm/contracts';
import type { CommandSegment } from './command-target.js';
import { canonicalizeArgv, commandBasename, parseShellSource } from './command-target.js';

/**
 * 一条命令 → 一组「能力 + 目标」主张（ADR-0026）。
 *
 * ── 为什么必须有这一层 ──
 *
 * M1-d 的 DoD 第一条是「`rm -rf ~` 被拦」。而在这个文件出现之前，`shell.exec` 能做的
 * 只有一件事：拿自己声明的那一个能力去判一次。于是判定路径是
 *
 *     shell.exec + 一条命令行 → def.shell-exec → **ask**
 *
 * 而 `red.fs-delete-home-root` 挂在 `fs.delete` 上，压根不会被查——
 * `rm -rf ~` 的结局是一个确认框，不是拦截。ADR-0020 早就说过"别用 glob 匹配命令行"，
 * 那句话是对的，但它留下的空白一直没人填：**不匹配命令行，那匹配什么？**
 *
 * 答案是匹配它**动的那个东西**。`rm -rf ~` 产出一条 `fs.delete /home/ming` 的主张，
 * 撞上一条 M0 就写好的红线。这是 ADR-0014 那半个教训的第三次应用：
 * **红线按"目标是什么"写，不按"调用方自称在做什么"写。**
 *
 * 顺带白拿两样东西：
 *   · `cat ~/.ssh/id_rsa` 撞上 ADR-0025 那 20 条读取 deny —— 一条新规则都不用写；
 *   · `curl` 产出 `net.fetch` 主张，于是 `tool.start.capabilities` 里有了它，
 *     `untrustedContext` 自动置上 —— 否则"用 shell 跑 curl"就是整套注入降级的绕过口。
 *
 * ── 这张表**只能加主张，不能减** ──
 *
 * 表里没有的 bin，产出的主张就只有 `shell.exec` 一条，落回 `def.shell-exec` 的 ask。
 * 所以"漏了一条表项"的后果是**退回到今天的行为**，不是放行。这条性质必须一直成立，
 * 它是这张表可以慢慢长、而不必先证明自己完备的全部依据。有一条用例钉着它。
 *
 * 反过来说，这张表**不是**一道防线：它拦不住一个改了名的 `rm`。真正的防线是
 * 那些按路径写的规则，这张表只是把命令翻译成它们看得懂的话。
 */

/** 一条主张的目标。`path` 还需要网关去展开与 realpath，`literal` 是终态 */
export type ClaimTarget =
  | { readonly kind: 'path'; readonly raw: string }
  | { readonly kind: 'literal'; readonly value: string };

export interface CommandClaim {
  readonly capability: Capability;
  readonly target: ClaimTarget;
}

export type CommandAnalysis =
  | { readonly ok: true; readonly canonical: string; readonly claims: readonly CommandClaim[] }
  | { readonly ok: false; readonly reason: string };

/** 操作数的角色：这些位置上的路径各自意味着什么能力 */
type OperandRole = 'read' | 'write' | 'delete' | 'copy' | 'move';

interface CommandProfile {
  readonly kind?: 'prefix' | 'shell' | 'deny' | 'git' | 'package' | 'net';
  readonly operands?: OperandRole;
  /** 前几个操作数不是路径（`chmod 755 f` 的模式、`git` 的子命令） */
  readonly skip?: number;
}

/**
 * 画像表。挑选标准只有一条：
 *
 * > **这个 bin 的典型用法会碰到一个"已经有规则管着"的目标**（路径、网络目的地）。
 *
 * 按这条标准，`echo` / `ls` 之外的绝大多数命令都不进表——不是因为它们安全，
 * 而是因为把它们翻译过去也匹配不到任何规则，徒增噪音。`ls` 进表是因为
 * `ls ~/.ssh` 确实该被 ADR-0025 拦下（列目录也是 `fs.read`）。
 */
const PROFILES: Readonly<Record<string, CommandProfile>> = {
  // 删
  rm: { operands: 'delete' },
  rmdir: { operands: 'delete' },
  unlink: { operands: 'delete' },
  shred: { operands: 'delete' },

  // 写
  cp: { operands: 'copy' },
  mv: { operands: 'move' },
  tee: { operands: 'write' },
  ln: { operands: 'write' },
  mkdir: { operands: 'write' },
  touch: { operands: 'write' },
  chmod: { operands: 'write', skip: 1 },
  chown: { operands: 'write', skip: 1 },
  chgrp: { operands: 'write', skip: 1 },

  // 读
  cat: { operands: 'read' },
  head: { operands: 'read' },
  tail: { operands: 'read' },
  less: { operands: 'read' },
  more: { operands: 'read' },
  ls: { operands: 'read' },
  grep: { operands: 'read', skip: 1 },
  rg: { operands: 'read', skip: 1 },
  find: { operands: 'read' },
  wc: { operands: 'read' },
  diff: { operands: 'read' },

  // 网。非 URL 的操作数按写处理：`curl -o out.txt <url>` 的 out.txt 是要落盘的
  curl: { kind: 'net' },
  wget: { kind: 'net' },

  // 包管理器：看子命令
  npm: { kind: 'package' },
  pnpm: { kind: 'package' },
  yarn: { kind: 'package' },
  pip: { kind: 'package' },
  pip3: { kind: 'package' },
  cargo: { kind: 'package' },
  gem: { kind: 'package' },
  apt: { kind: 'package' },
  'apt-get': { kind: 'package' },
  brew: { kind: 'package' },

  git: { kind: 'git' },

  /*
   * 命令前缀：它们自己什么也不做，真正跑的是后面那条。**必须递归**——
   * 否则 `env FOO=1 rm -rf /` 的 bin 是 `env`，表里查不到，整条命令降回一个 ask。
   */
  env: { kind: 'prefix' },
  nohup: { kind: 'prefix' },
  timeout: { kind: 'prefix' },
  nice: { kind: 'prefix' },
  ionice: { kind: 'prefix' },
  stdbuf: { kind: 'prefix' },
  command: { kind: 'prefix' },

  // shell -c：内层那个字符串才是真正要跑的东西
  sh: { kind: 'shell' },
  bash: { kind: 'shell' },
  zsh: { kind: 'shell' },
  dash: { kind: 'shell' },
  ksh: { kind: 'shell' },
  ash: { kind: 'shell' },
  fish: { kind: 'shell' },

  /*
   * 判不了，且判不了的方式是**结构性**的：
   *   · `sudo` / `su` / `doas` 之后跑的东西不再受本进程的任何约束（连 env 白名单都失效）
   *   · `xargs` 的参数来自 stdin，执行前谁也不知道它会拿到什么
   *   · `dd` 的 `if=` / `of=` 是一套自成体系的参数语法，按操作数解出来的东西是错的
   *
   * 处置不是在这里抛错，而是产出一条**带目标的 `shell.exec` 主张**，
   * 由 `defaults.ts` 里的普通 deny 规则接住——于是用户在自己的配置里写一条 allow
   * 就能放开某一条（ADR-0025 定下的形状：给不出出口的安全措施最后都会被整体关掉）。
   */
  sudo: { kind: 'deny' },
  su: { kind: 'deny' },
  doas: { kind: 'deny' },
  xargs: { kind: 'deny' },
  dd: { kind: 'deny' },
};

/** 被 `deny` 画像点名的 bin。`defaults.ts` 据此生成规则，两边不会分叉 */
export const DENIED_COMMAND_BINS: readonly string[] = Object.keys(PROFILES).filter(
  (bin) => PROFILES[bin]?.kind === 'deny',
);

const PACKAGE_SUBCOMMANDS = new Set(['install', 'add', 'i', 'ci', 'update', 'upgrade', 'global']);
const GIT_WRITE_SUBCOMMANDS = new Set([
  'commit', 'add', 'rm', 'mv', 'checkout', 'switch', 'restore', 'merge', 'rebase',
  'reset', 'clean', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'tag', 'branch',
  'init', 'clone', 'fetch', 'pull', 'submodule', 'config', 'gc', 'worktree',
]);

/**
 * 分析 `shell.exec` 收到的 argv 数组。
 *
 * ⚠️ argv 的每个元素都是**字面量**，不走 shell 语义：一个内容是 `*.ts` 的元素
 * 是文件名，不是通配符。只有 `sh -c` 后面那个字符串才是 shell 源码，
 * 它由 `parseShellSource` 单独处理。
 */
export function analyzeArgv(argv: readonly string[]): CommandAnalysis {
  if (argv.length === 0 || (argv[0] ?? '') === '') {
    return { ok: false, reason: '命令为空。' };
  }
  const canonical = canonicalizeArgv(argv);
  const derived = claimsOf({ argv, redirects: [] }, 0);
  if (!derived.ok) return derived;

  return {
    ok: true,
    canonical,
    claims: dedupe([
      { capability: 'shell.exec', target: { kind: 'literal', value: canonical } },
      ...derived.claims,
    ]),
  };
}

type Derived =
  | { readonly ok: true; readonly claims: readonly CommandClaim[] }
  | { readonly ok: false; readonly reason: string };

/** 递归深度上限。`env env env …` 不是正经命令，但它也不该让我们无限递归下去 */
const MAX_DEPTH = 8;

function claimsOf(segment: CommandSegment, depth: number): Derived {
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: '命令的嵌套层数过多，判不了。' };
  }

  const [bin = '', ...args] = segment.argv;
  const base = commandBasename(bin);
  const profile = PROFILES[base];

  const claims: CommandClaim[] = segment.redirects.map((r) => ({
    capability: r.mode === 'write' ? ('fs.write' as const) : ('fs.read' as const),
    target: { kind: 'path' as const, raw: r.path },
  }));

  if (profile === undefined) return { ok: true, claims };

  switch (profile.kind) {
    case 'deny':
      /*
       * 多产出一条带目标的 `shell.exec` 主张，而不是就地抛错。
       * 目标用**这一层**的规范形式：`env sudo rm -rf /` 里的 `sudo …` 因此照样露头，
       * 而如果只看最外层那个串，包一层 `env` 就绕过去了。
       */
      return {
        ok: true,
        claims: [
          ...claims,
          { capability: 'shell.exec', target: { kind: 'literal', value: canonicalizeArgv(segment.argv) } },
        ],
      };

    case 'prefix': {
      /*
       * 剩下的第一个词才是真正要跑的命令。它前面可能有三种东西，都要跳过：
       * 前缀自己的选项、`FOO=bar` 形式的赋值（`env`）、以及一个纯数字量
       * （`timeout 5 …`、`nice -n 10 …`）。少跳一种的后果很具体：
       * `timeout 5 rm -rf /` 会把 `5` 当成要跑的命令，于是 `rm` 那一层整个消失。
       */
      const at = args.findIndex((a) => !isPrefixNoise(a));
      if (at === -1) return { ok: true, claims };
      const inner = claimsOf({ argv: args.slice(at), redirects: [] }, depth + 1);
      if (!inner.ok) return inner;
      return { ok: true, claims: [...claims, ...inner.claims] };
    }

    case 'shell': {
      const at = args.findIndex((a) => a === '-c');
      const source = at === -1 ? undefined : args[at + 1];
      if (source === undefined) {
        /*
         * 没有 `-c`：跑的是一个脚本文件，内容判不了。产出一条 `fs.read` 主张
         * （脚本本身要被读），其余照旧落回 `def.shell-exec` 的 ask。
         * 这是一个**已知缺口**并写进了 ADR-0026 遗留：`bash ./build.sh` 里面写什么都行。
         */
        const file = operandsOf(args, 0)[0];
        return {
          ok: true,
          claims: file === undefined ? claims : [...claims, { capability: 'fs.read', target: { kind: 'path', raw: file } }],
        };
      }
      const parsed = parseShellSource(source);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const out = [...claims];
      for (const seg of parsed.segments) {
        const inner = claimsOf(seg, depth + 1);
        if (!inner.ok) return inner;
        out.push(...inner.claims);
      }
      return { ok: true, claims: out };
    }

    case 'git': {
      const sub = operandsOf(args, 0)[0];
      if (sub === 'push') {
        return { ok: true, claims: [...claims, { capability: 'git.push', target: { kind: 'literal', value: '' } }] };
      }
      if (sub !== undefined && GIT_WRITE_SUBCOMMANDS.has(sub)) {
        return { ok: true, claims: [...claims, { capability: 'git.write', target: { kind: 'literal', value: '' } }] };
      }
      return { ok: true, claims };
    }

    case 'package': {
      const subs = operandsOf(args, 0);
      const installing = subs.some((s) => PACKAGE_SUBCOMMANDS.has(s));
      return {
        ok: true,
        claims: installing
          ? [...claims, { capability: 'package.install', target: { kind: 'literal', value: base } }]
          : claims,
      };
    }

    case 'net': {
      const ops = operandsOf(args, 0);
      const urls = ops.filter((o) => /^https?:\/\//i.test(o));
      if (urls.length === 0) {
        /*
         * 判不出它要访问哪里。这不是策略拒绝，是**调用本身没写清楚**——
         * 所以走网关的失败关闭（模型会看到这句话并可以改写重试），
         * 而不是产出一条注定 deny 的主张。
         */
        return {
          ok: false,
          reason:
            `${base} 的参数里没有一个完整的 http(s) URL，判不出它要访问哪个地址。` +
            `把 URL 写全（带 http:// 或 https://）。`,
        };
      }
      return {
        ok: true,
        claims: [
          ...claims,
          ...urls.map((u) => ({ capability: 'net.fetch' as const, target: { kind: 'literal' as const, value: u } })),
          // 非 URL 的操作数按落盘处理：`curl -o ~/.bashrc <url>` 必须被写入侧规则看见
          ...ops
            .filter((o) => !/^https?:\/\//i.test(o))
            .map((o) => ({ capability: 'fs.write' as const, target: { kind: 'path' as const, raw: o } })),
        ],
      };
    }

    default:
      return { ok: true, claims: [...claims, ...pathClaims(profile, args)] };
  }
}

/** 前缀命令自己的那几个词：选项、`FOO=bar`、时长/优先级这类纯数字量 */
const isPrefixNoise = (arg: string): boolean =>
  arg.startsWith('-') ||
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) ||
  /^\d+(\.\d+)?[smhd]?$/.test(arg);

function pathClaims(profile: CommandProfile, args: readonly string[]): CommandClaim[] {
  const role = profile.operands;
  if (role === undefined) return [];
  const ops = operandsOf(args, profile.skip ?? 0);
  if (ops.length === 0) return [];

  const path = (raw: string): ClaimTarget => ({ kind: 'path', raw });

  switch (role) {
    case 'read':
      return ops.map((o) => ({ capability: 'fs.read', target: path(o) }));
    case 'write':
      return ops.map((o) => ({ capability: 'fs.write', target: path(o) }));
    case 'delete':
      return ops.map((o) => ({ capability: 'fs.delete', target: path(o) }));
    case 'copy':
    case 'move': {
      // 最后一个是目的地，其余是来源。`mv` 的来源会消失，所以它同时是一次删除
      const dest = ops[ops.length - 1] ?? '';
      const sources = ops.slice(0, -1);
      return [
        ...sources.flatMap((s): CommandClaim[] =>
          role === 'move'
            ? [
                { capability: 'fs.read', target: path(s) },
                { capability: 'fs.delete', target: path(s) },
              ]
            : [{ capability: 'fs.read', target: path(s) }],
        ),
        { capability: 'fs.write', target: path(dest) },
      ];
    }
  }
}

/**
 * 从参数里挑出操作数：跳过 `-x` / `--x` 形式的选项，`--` 之后一律算操作数。
 *
 * **刻意不认识"选项带值"**（`-o out.txt` 里的 `out.txt`）。认错的两种方向后果不对称：
 * 把选项值误当成路径，多出一条几乎必然匹配不上任何规则的主张（代价是一次多余的确认）；
 * 把路径误当成选项值而漏掉，那条主张就没了（代价是一次静默放行）。
 */
function operandsOf(args: readonly string[], skip: number): string[] {
  const out: string[] = [];
  let literal = false;
  for (const a of args) {
    if (!literal && a === '--') {
      literal = true;
      continue;
    }
    if (!literal && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out.slice(skip);
}

/** 同一个 (能力, 目标) 只判一次——否则一条 `cp a a` 会让用户点两次同样的确认框 */
function dedupe(claims: readonly CommandClaim[]): readonly CommandClaim[] {
  const seen = new Set<string>();
  const out: CommandClaim[] = [];
  for (const c of claims) {
    const key = `${c.capability} ${c.target.kind} ${
      c.target.kind === 'path' ? c.target.raw : c.target.value
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
