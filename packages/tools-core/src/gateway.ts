import { realpath as realpathCb } from 'node:fs';
import { lookup as dnsLookupNode } from 'node:dns/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isPathCapability, targetKindOf } from '@xm/contracts';
import type {
  PermissionClaim,
  RegisteredTool,
  ResolvedCall,
  ToolContext,
  ToolGateway,
} from '@xm/kernel';
import {
  GatewayError,
  analyzeArgv,
  claimsOfCapabilities,
  normalizeHostTarget,
  normalizePathTarget,
} from '@xm/kernel';

/**
 * **必须是 `.native`。**
 *
 * `fs.promises.realpath` 是 JS 实现，它解符号链接，但**解不了 Windows 的 8.3 短名**——
 * 而 ADR-0024 关闭 ADR-0018 遗留时写的正是"realpath.native 顺带把短名展开成长名"。
 * 文档里写着 `.native`、代码里用的是另一个，这条遗留就只是看起来被关掉了。
 * （`fs/promises` 上没有 `.native`，所以从回调版 promisify 过来。）
 */
const realpath = promisify(realpathCb.native);

/**
 * 路径能力网关的 Node 实现（ADR-0024）。
 *
 * 做四件事，每一件都是内核做不了的（它零 I/O）：
 *
 *   一、**相对 → 绝对**，基准是会话的 `cwd`。
 *   二、**realpath**：符号链接、`.`/`..`、以及 Windows 8.3 短名一并解析掉。
 *   三、**回写入参**：解析后的路径写回 `input`，判定与执行因此共用同一个字符串。
 *   四、**声明缺失就拒绝**：声明了路径类能力却没声明 `pathInputs`，当场失败关闭。
 *
 * ── 不存在的文件怎么办 ──
 *
 * `fs.write` 的目标经常还不存在，而 `realpath` 对不存在的路径直接抛 ENOENT。
 * 所以这里的做法是**逐级向上找到最深的存在祖先，realpath 它，再把剩下的段拼回去**。
 * 这不是权宜之计：符号链接逃逸的载体一定是某个**已经存在**的目录段，
 * 而那一段必然在这个祖先里。把 `/work/link-to-etc/x.txt` 解析成
 * `/etc/x.txt` 靠的正是这一步。
 *
 * ── 剩下的那个窗口，得说清楚 ──
 *
 * 解析完到工具真正 open 之间仍有时间差：中途把某一段换成符号链接，判定就落在旧目标上。
 * 这个窗口关不掉——**关它需要在打开的文件描述符上判定**，而那要么改成"网关自己打开文件、
 * 把 fd 交给工具"，要么依赖执行器沙箱（docs/09 C2，M1-d 前定案）。
 * 现在的姿态是：把窗口从"整条路径随便换"缩到"要在毫秒级里抢",并如实记在这里，
 * 而不是假装它不存在。
 */

export interface NodeGatewayOptions {
  /**
   * 覆盖 `ToolContext.cwd`。省略则用上下文里的——那才是常态，
   * 每个会话有自己的工作目录。
   */
  readonly cwd?: string;
  /**
   * 用户主目录，用来展开命令参数里的 `~`。
   *
   * 内核不许展开（零 I/O，`normalizePathTarget` 对 `~` 开头一律失败关闭），
   * 而 `rm -rf ~` 这条命令的判定**必须**建立在展开之后的路径上——
   * 不展开的话它判成"删一个叫 `~` 的文件"，与模型的本意不是一回事，
   * 而 M1-d 的 DoD 第一条正是这条命令要被拦下。
   *
   * 省略则不展开：带 `~` 的路径会在内核那里失败关闭地 deny，行为仍然是安全的。
   */
  readonly home?: string;
  /**
   * DNS 解析的注入点（M1-d，web.fetch 的 IP 级 SSRF 判定）。省略则用
   * `node:dns/promises` 的真实解析——测试用假实现替换它，不发真实网络请求。
   *
   * 与 `cwd`/`home` 是同一个模式：生产环境用真实实现，测试注入桩。
   */
  readonly dnsLookup?: (
    hostname: string,
  ) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
}

export const nodeToolGateway = (options: NodeGatewayOptions = {}): ToolGateway => ({
  async resolve(tool: RegisteredTool, input: unknown, ctx: ToolContext): Promise<ResolvedCall> {
    const needsCommand = tool.descriptor.capabilities.some((c) => targetKindOf(c) === 'command');
    if (needsCommand) return resolveCommand(tool, input, ctx, options);

    const needsHost = tool.descriptor.capabilities.some((c) => targetKindOf(c) === 'host');
    if (needsHost) return resolveHost(tool, input, options);

    const needsPath = tool.descriptor.capabilities.some(isPathCapability);

    if (tool.pathInputs.length === 0) {
      /*
       * 声明了路径类能力却没有 `pathInputs`——**拒绝，不放行**。
       *
       * 放行的后果是这次调用的 target 是空字符串，于是它只被能力级规则判定，
       * 所有基于路径的规则（包括红线）全部匹配不上。那是一个安静的整体绕过，
       * 而它的起因只是有人加工具时漏写了一个字段。
       */
      if (needsPath) {
        throw new GatewayError(
          `工具 ${tool.descriptor.name} 声明了路径类能力，却没有声明 pathInputs——` +
            `网关无法知道哪个入参是路径，也就判不出这次操作动的是哪个文件。` +
            `这会让所有基于路径的规则（含红线）匹配不上，因此直接拒绝。`,
          { tool: tool.descriptor.name },
        );
      }
      return { input, claims: claimsOfCapabilities(tool.descriptor.capabilities, '') };
    }

    const cwd = options.cwd ?? ctx.cwd;
    if (!isAbsolute(cwd)) {
      throw new GatewayError(
        `会话的工作目录 "${cwd}" 不是绝对路径，无法据此解析相对路径。`,
        { cwd },
      );
    }

    const record = asRecord(input, tool.descriptor.name);
    const out: Record<string, unknown> = { ...record };
    let target = '';

    for (const field of tool.pathInputs) {
      const raw = record[field];
      // 可选的路径字段没给值就跳过——它不是错误，只是这次调用没用到
      if (raw === undefined) continue;
      if (typeof raw !== 'string' || raw === '') {
        throw new GatewayError(
          `工具 ${tool.descriptor.name} 的入参 "${field}" 应当是一个非空路径字符串。`,
          { tool: tool.descriptor.name, field },
        );
      }

      const resolved = canonical(await resolveDeep(resolve(cwd, raw)), tool.descriptor.name, field);
      out[field] = resolved;
      // 第一个声明的字段就是判权用的 target（`pathInputs` 按判权重要性排序）
      if (target === '') target = resolved;
    }

    return { input: out, claims: claimsOfCapabilities(tool.descriptor.capabilities, target) };
  },
});

/**
 * 命令类调用的解析（ADR-0026）。
 *
 * 与路径分支的分工是一样的：内核把命令拆成一组「能力 + 目标」的**主张**（纯函数），
 * 这里负责它做不了的那一半——把主张里的路径展开 `~`、绝对化、realpath。
 * 用的是**同一个** `resolveDeep` / `canonical`：一个文件无论来自 `fs.read {path}`
 * 还是 `rm <path>`，解析它的代码只有一份，两条路不会慢慢分叉。
 *
 * ── 为什么不像路径分支那样把解析后的路径写回 argv ──
 *
 * 路径工具必须回写，因为判定看到 realpath、执行拿着符号链接就是两个东西。
 * 命令不同：它执行时由**操作系统**按同一个 cwd 去解析同一个相对路径 / 符号链接，
 * 落到的是同一个文件。判定用的是解析后的（更严的）那个，执行落到同一处，
 * 两边不会分叉。而回写会实实在在地改变命令的行为（`git status`、`find .` 的输出
 * 都依赖参数原样）。
 *
 * **唯一的例外是 `~`**，它必须回写：没有 shell 参与时 `~` 就是一个普通文件名，
 * 判定按家目录判、执行按字面量跑，那才是两个东西。
 */
async function resolveCommand(
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolContext,
  options: NodeGatewayOptions,
): Promise<ResolvedCall> {
  const name = tool.descriptor.name;
  const fields = tool.commandInputs;

  if (fields === undefined) {
    /*
     * 声明了命令类能力却没有 `commandInputs`——**拒绝，不放行**。
     * 与 `pathInputs` 那道检查同一个理由：不知道命令是什么，就判不出它会动什么，
     * 而这次调用会以一个空 target 通过所有基于目标的规则（含红线）。
     */
    throw new GatewayError(
      `工具 ${name} 声明了命令类能力，却没有声明 commandInputs——` +
        `网关无法知道哪个入参是命令，也就拆不出它会动什么。` +
        `这会让所有基于目标的规则（含红线）匹配不上，因此直接拒绝。`,
      { tool: name },
    );
  }

  const record = asRecord(input, name);
  const rawArgv = record[fields.argv];
  if (!Array.isArray(rawArgv) || rawArgv.some((a) => typeof a !== 'string')) {
    throw new GatewayError(`工具 ${name} 的入参 "${fields.argv}" 应当是一个字符串数组。`, {
      tool: name,
      field: fields.argv,
    });
  }

  const cwdField = fields.cwd === undefined ? undefined : record[fields.cwd];
  const cwd = await resolveCwd(cwdField, options.cwd ?? ctx.cwd, name);
  const argv = (rawArgv as string[]).map((a) => expandHome(a, options.home));

  const analysis = analyzeArgv(argv);
  if (!analysis.ok) throw new GatewayError(analysis.reason, { tool: name });

  const claims: PermissionClaim[] = tool.descriptor.capabilities
    .filter((c) => targetKindOf(c) === 'command')
    .map((capability) => ({ capability, target: analysis.canonical }));

  for (const claim of analysis.claims) {
    if (claim.target.kind === 'literal') {
      claims.push({ capability: claim.capability, target: claim.target.value });
      continue;
    }
    const expanded = expandHome(claim.target.raw, options.home);
    claims.push({
      capability: claim.capability,
      target: canonical(await resolveDeep(resolve(cwd, expanded)), name, fields.argv),
    });
  }

  const out: Record<string, unknown> = { ...record, [fields.argv]: argv };
  if (fields.cwd !== undefined) out[fields.cwd] = cwd;

  return { input: out, claims: dedupeClaims(claims) };
}

/** 命令的工作目录：给了就 realpath 它，没给就用会话的 */
async function resolveCwd(raw: unknown, fallback: string, tool: string): Promise<string> {
  if (!isAbsolute(fallback)) {
    throw new GatewayError(`会话的工作目录 "${fallback}" 不是绝对路径，无法据此解析。`, {
      cwd: fallback,
    });
  }
  const candidate = typeof raw === 'string' && raw !== '' ? resolve(fallback, raw) : fallback;
  return canonical(await resolveDeep(candidate), tool, 'cwd');
}

/**
 * 网络类调用的解析（M1-d，web.fetch 的 IP 级 SSRF 判定）。
 *
 * 与路径/命令分支同一个分工：内核（`normalizeHostTarget`）只做词法归一，
 * 它自己写明了"真正的 SSRF 防御是在发请求的那一层按解析出的 IP 判定"——这里就是
 * 那一层。做两件内核做不了的事（它零 I/O）：
 *
 *   一、**DNS 解析**，且只在这里解析一次。
 *   二、**产出两条 claim**：一条是原始域名（命中默认的 `ask`，用户在确认框里看到
 *      可读的域名），一条是解析出的 IP 拼成的合法 URL（命中新增的 IP 段 deny）。
 *      两条都挂在同一个能力上，`turn.ts` 现有的"任一 claim 被拒即整体拒"不用改一行
 *      代码就能让两道闸门同时生效。
 *
 * ── 为什么不像路径分支那样回写入参 ──
 *
 * 路径分支回写是因为判定看到的路径必须与执行打开的路径是同一个字符串。网络场景做
 * 不到同样的事——URL 字符串本身不能被改写成解析出的 IP：改了 Host 就变了 SNI/虚拟主机
 * 语义，工具连的就不再是同一个"名字"了。真正需要"判定与执行共用同一个值"的是**地址**，
 * 不是 URL 本身，所以这里走的是 `ResolvedCall.pinnedHosts` 这条带外通道：把这次解析
 * 出的地址原样交给执行阶段，工具建连时只准用这张表里的地址，不许自己再解析一次——
 * 这是唯一能保证"判定用的 IP = 实际建连的 IP"、从而堵死 DNS rebinding 窗口的做法。
 */
async function resolveHost(
  tool: RegisteredTool,
  input: unknown,
  options: NodeGatewayOptions,
): Promise<ResolvedCall> {
  const name = tool.descriptor.name;

  if (tool.hostInputs.length === 0) {
    /*
     * 声明了网络类能力却没有 `hostInputs`——**拒绝，不放行**。与 `pathInputs`/
     * `commandInputs` 缺失时同一个理由：不知道 URL 在哪个字段，就判不出这次调用
     * 要去哪，这次调用会以一个空 target 通过所有基于目标的规则（含 IP 段判定）。
     */
    throw new GatewayError(
      `工具 ${name} 声明了网络类能力，却没有声明 hostInputs——` +
        `网关无法知道哪个入参是网络目的地，也就判不出这次调用要连到哪。` +
        `这会让所有基于目标的规则（含 IP 段判定）匹配不上，因此直接拒绝。`,
      { tool: name },
    );
  }

  const record = asRecord(input, name);
  const hostCapabilities = tool.descriptor.capabilities.filter((c) => targetKindOf(c) === 'host');
  const lookup = options.dnsLookup ?? defaultDnsLookup;
  const claims: PermissionClaim[] = [];
  const pinnedHosts = new Map<string, { address: string; family: 4 | 6 }>();
  let any = false;

  for (const field of tool.hostInputs) {
    const raw = record[field];
    // 可选的网络目的地字段没给值就跳过——与 pathInputs 同一个宽容度
    if (raw === undefined) continue;
    any = true;
    if (typeof raw !== 'string' || raw === '') {
      throw new GatewayError(
        `工具 ${name} 的入参 "${field}" 应当是一个非空的 URL 字符串。`,
        { tool: name, field },
      );
    }

    const normalized = normalizeHostTarget(raw);
    if (!normalized.ok) {
      /*
       * 判不了：不抛错，产出一条带原始字符串的 claim，交给 `evaluate()` 已有的
       * "target 规范化失败 → deny"逻辑接住（与 `resolveCommand` 里"判不了的命令
       * 交给规则判"是同一个分工），不在这一层重复判定逻辑。
       */
      for (const capability of hostCapabilities) claims.push({ capability, target: raw });
      continue;
    }

    const { host, port } = splitNormalizedHostPort(normalized.value);
    const dnsHostname = host.startsWith('[') ? host.slice(1, -1) : host;

    let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
    try {
      addresses = await lookup(dnsHostname);
    } catch (err) {
      // 解析失败：不问、不发权限事件——判不了就不放行，与其它"判不了"分支同一个姿态
      throw new GatewayError(
        `工具 ${name} 的入参 "${field}" 里的主机 "${dnsHostname}" 无法解析：` +
          `${err instanceof Error ? err.message : String(err)}。` +
          `解析不了就不放行——网关不知道这次调用真正会连到哪。`,
        { tool: name, field, host: dnsHostname },
      );
    }
    const first = addresses[0];
    if (first === undefined) {
      throw new GatewayError(
        `工具 ${name} 的入参 "${field}" 里的主机 "${dnsHostname}" 没有解析出任何地址。`,
        { tool: name, field, host: dnsHostname },
      );
    }

    // 判定与执行共用同一个地址——见本函数顶部注释
    pinnedHosts.set(host, { address: first.address, family: first.family });

    const scheme = (/^(https?):\/\//i.exec(raw)?.[1] ?? 'http').toLowerCase();
    const ipLiteral = first.family === 6 ? `[${first.address}]` : first.address;
    const ipUrl = `${scheme}://${ipLiteral}${port === undefined ? '' : `:${port}`}/`;

    for (const capability of hostCapabilities) {
      claims.push({ capability, target: raw }); // claim A：可读域名，命中默认 ask
      claims.push({ capability, target: ipUrl }); // claim B：解析出的 IP，命中 IP 段 deny
    }
  }

  if (!any) {
    /*
     * 一条网络目的地字段都没给值——与路径分支同一个兜底：仍然覆盖每个声明的能力
     * （`PermissionClaim` 的不变量是"主张只能加不能减"），空 target 会在
     * `evaluate()` 里被 `normalizeHostTarget` 判定为失败关闭，不是静默放行。
     */
    for (const capability of hostCapabilities) claims.push({ capability, target: '' });
  }

  return { input, claims: dedupeClaims(claims), pinnedHosts };
}

/** 把 `normalizeHostTarget` 归一后的 `host[:port]` 拆开——IPv6 是 `[::1]:8080` 这种形状 */
function splitNormalizedHostPort(value: string): { host: string; port: string | undefined } {
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    const host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    return { host, port: rest.startsWith(':') ? rest.slice(1) : undefined };
  }
  const idx = value.lastIndexOf(':');
  return idx === -1 ? { host: value, port: undefined } : { host: value.slice(0, idx), port: value.slice(idx + 1) };
}

async function defaultDnsLookup(
  hostname: string,
): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]> {
  const results = await dnsLookupNode(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

/**
 * 展开**词首**的 `~`。只认 `~` 与 `~/…`——`~user` 在内核的词法器那里已经被拒了，
 * 而段中间的 `~` 是合法文件名（Windows 8.3 短名、emacs 备份文件），碰不得。
 */
function expandHome(arg: string, home: string | undefined): string {
  if (home === undefined) return arg;
  if (arg === '~') return home;
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return join(home, arg.slice(2));
  return arg;
}

const dedupeClaims = (claims: readonly PermissionClaim[]): readonly PermissionClaim[] => {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const key = `${c.capability} ${c.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * 把 realpath 出来的**平台原生**路径，变成内核判定用的那个坐标系里的字符串。
 *
 * ── 为什么不是"算出 target 就够了" ──
 *
 * ADR-0024 的要害是"判定看到的那个路径，必须就是工具打开的那个路径"。
 * 而 `evaluate()` 拿到 target 之后还会再规范化一次（正斜杠、盘符大写）。
 * 于是在 Windows 上，如果这里回写的是 `C:\work\a.md` 而判定比的是 `C:/work/a.md`，
 * 事件流里记的、授权里存的、规则里写的就又变成了三个不同的字符串——
 * 「本会话都允许」下一次照样弹框，而没有任何地方看得出为什么。
 *
 * 所以这里就把它归到最终形态：**入参、target、事件、授权，从这一行起是同一个串**。
 * Node 的 fs API 在 Windows 上一律接受正斜杠，所以回写正斜杠不影响任何工具。
 * POSIX 上这一步是恒等变换——它改变的只有 Windows 的行为。
 *
 * `\\?\` 前缀（长路径形态，`realpath.native` 在某些卷上会返回它）必须先摘掉：
 * 内核会把它当成一个以 `/` 开头的 POSIX 路径，规范化成 `/?/C:/...`，那是个匹配不上
 * 任何规则的怪串——**一条静默失效的红线，比一条报错的红线危险得多**。
 */
function canonical(nativePath: string, tool: string, field: string): string {
  const stripped = nativePath.replace(/^\\\\\?\\(UNC\\)?/, (_m, unc: string | undefined) =>
    unc === undefined ? '' : '\\\\',
  );

  /*
   * UNC（`\\server\share\...`）**当场拒绝**，不是"尽力而为"。
   *
   * 内核的归一没有 UNC 契约：`\\server\share\x` 会被当成一个以 `/` 开头的 POSIX 路径，
   * 归一成 `/server/share/x`。那个串有两个问题，每个单独都足以拒绝——
   *   · 拿它去执行，Windows 会解析成**当前盘的根目录**下，与用户说的不是一个地方；
   *   · 拿它去判定，它和一条写给 POSIX 的 `/server/**` 规则形状完全相同。
   *
   * 与 8.3 短名同一个处置：判不了就明确地判不了，不给一层看起来能用的假防线。
   */
  if (/^[\\/]{2}/.test(stripped)) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 指向一个 UNC 网络路径（${nativePath}）。` +
        `路径归一还没有 UNC 契约，判定会落在错误的坐标系上，因此这里直接拒绝。`,
      { tool, field, path: nativePath },
    );
  }

  const normalized = normalizePathTarget(stripped);
  if (!normalized.ok) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 解析出的路径 "${nativePath}" 无法规范化：` +
        normalized.reason,
      { tool, field, path: nativePath },
    );
  }
  return normalized.value;
}

/**
 * realpath 一个可能还不存在的路径。
 *
 * 向上找到最深的存在祖先并解析它，再把剩余段原样拼回去。
 * 每一段都不做任何"聪明"的处理——`..` 在这里已经被 `resolve()` 消解过，
 * 而剩余段按定义是不存在的，没有链接可解。
 */
async function resolveDeep(absolute: string): Promise<string> {
  const rest: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const real = await realpath(cursor);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        /*
         * 走到了根还是解析不了。这在正常的文件系统上几乎不可能发生
         * （根一定存在），所以它更可能意味着权限问题或路径畸形——
         * 无论哪种，**都不是可以按未解析路径继续判定的理由**。
         */
        throw new GatewayError(`无法解析路径 "${absolute}"：向上到根都不存在或不可访问。`, {
          path: absolute,
        });
      }
      rest.push(cursor.slice(parent.length).replaceAll(sep, ''));
      cursor = parent;
    }
  }
}

function asRecord(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GatewayError(`工具 ${toolName} 的入参不是一个对象，无法从中取出路径字段。`, {
      tool: toolName,
    });
  }
  return input as Record<string, unknown>;
}
