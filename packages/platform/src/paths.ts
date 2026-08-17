import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import envPaths from 'env-paths';
import type { XmPaths } from '@xm/kernel';
import { normalizedOrThrow } from '@xm/kernel';
import { homeDir } from './detect.js';

/**
 * 目录解析（ADR-0014）。
 *
 * 走 `env-paths` 的平台规范目录，而不是三平台统一的 `~/.xiaoming/`：
 *
 *   · macOS   `~/Library/Application Support/xiaoming`
 *   · Windows `%APPDATA%\xiaoming`
 *   · Linux   `~/.local/share/xiaoming`（config / cache / logs 各归其位）
 *
 * docs/06 §7 原先写死 `~/.xiaoming/audit.db`，与 ADR-0007 保险 4「用 env-paths 解析」
 * 冲突。选 env-paths 的理由是备份、迁移与卸载工具都认这些目录；代价是路径不再是
 * 一句话能背下来的常量——所以**它必须只有一个来源**，就是这里。
 *
 * `suffix: ''` 是必须的：env-paths 默认会加 `-nodejs` 后缀，那对库合适、对一个面向用户的
 * 桌面应用不合适（用户会在 Finder 里看到 `xiaoming-nodejs`）。
 */

export interface ResolvePathsOptions {
  /**
   * **入口位置**：小明这一份代码是从哪儿跑起来的。桌面传 `app.getAppPath()`，
   * headless 由入口决定。
   *
   * 这个字段以前叫 `appRoot`，注释写的是"仓库/安装目录"——而 `app.getAppPath()`
   * 两者都不是（开发时是 `apps/desktop`，打包后是 `resources/app.asar`）。
   * 整族自改红线因此锚在一个不存在的目录上（ADR-0078）。现在这里只表达"入口在哪"，
   * "源码树的根在哪"由 `findSourceRoot()` 从它往上找，两件事分开说。
   */
  readonly appPath: string;
  /**
   * 打包安装目录。**只有打包运行时才传**（`app.isPackaged`）。
   * 传了就意味着整棵树进红线，见 `XmPaths.installRoot`。
   */
  readonly installRoot?: string;
  readonly appName?: string;
  /** 覆盖家目录。仅供测试与红线演练使用 */
  readonly home?: string;
  /** 覆盖数据目录。仅供测试与 headless 冒烟使用（每次跑一个临时目录） */
  readonly dataDir?: string;
}

/** 看起来像 Windows 绝对路径（有盘符）且含 8.3 短名段 */
const WINDOWS_SHORT = /^[a-zA-Z]:[\\/].*[^\\/]{1,6}~\d{1,3}(\.[^\\/.]{1,3})?([\\/]|$)/;

/**
 * 把 Windows 的 8.3 短文件名解析成长名。
 *
 * **这一步必须在平台层做，不能在内核做**：短名↔长名的对应关系只有文件系统知道，
 * 而内核是零 I/O 的（它只能失败关闭地拒绝，见 kernel/policy/target.ts）。
 * 分工与符号链接完全一致——需要问磁盘的事，交给有磁盘的这一层。
 *
 * 为什么非做不可：`os.tmpdir()` 与 `%ProgramFiles%` 在 Windows 上都可能返回短名形态
 * （`C:\Users\RUNNER~1\...`、`C:\PROGRA~1\...`）。不解析，应用在 Windows 上直接起不到；
 * 解析错了，红线按长名写、请求按短名来，就是一条静默的绕过路径。
 *
 * `realpathSync.native` 走 OS API，是唯一能还原短名的方式（纯 JS 的 realpath 不行）。
 *
 * ⚠️ **只对 Windows 短名生效。** POSIX 路径原样返回，一个字节都不动——
 * realpath 会顺带解析符号链接，而那会把 macOS 的 `/var/...` 变成 `/private/var/...`，
 * 属于与本次修复无关的行为改变。要动它得单独决策。
 */
function resolveWindowsShortName(p: string): string {
  if (!WINDOWS_SHORT.test(p)) return p;

  // 路径可能还不存在（数据目录是用后才建的），所以从最深的**已存在**祖先开始解析，
  // 再把剩下的段拼回去。整条都不存在时原样返回，交给内核那一侧失败关闭。
  const tail: string[] = [];
  let head = p;
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return p;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

export function resolvePaths(options: ResolvePathsOptions): XmPaths {
  const name = options.appName ?? 'xiaoming';
  const base = envPaths(name, { suffix: '' });
  const norm = (p: string): string => normalizedOrThrow(resolveWindowsShortName(p));

  /*
   * 全部过一遍 normalizedOrThrow，得到的是**与红线规则同一个坐标系**的路径：
   * 分隔符统一成 `/`、盘符大写、无尾斜杠。
   *
   * 这一步不是洁癖。ADR-0012 ① 的失效就是这么发生的：红线里存的是一种写法，
   * 请求里传的是另一种写法，两边都"是路径"，匹配却永远不命中，而输出一直是"规则已配置"。
   * 现在两边都从这里出发，形状上就没有分叉的机会。
   */
  const appPath = norm(options.appPath);
  return {
    home: norm(options.home ?? homeDir()),
    /*
     * 源码树的根**推导出来，不照抄入口位置**（ADR-0078）。
     * 找不到标记就退回入口位置本身：那时自改红线的那些 glob 匹配不到东西，
     * 但真正起作用的是 `installRoot`——打包产物里本来就没有源码。
     */
    sourceRoot: findSourceRoot(appPath) ?? appPath,
    ...(options.installRoot === undefined ? {} : { installRoot: norm(options.installRoot) }),
    data: norm(options.dataDir ?? base.data),
    config: norm(base.config),
    cache: norm(base.cache),
    logs: norm(base.log),
  };
}

/**
 * 判断一个目录是不是**小明的源码树的根**，是就返回它，不是就往上一级继续找。
 *
 * ── 为什么必须"找"，不能"传" ──
 *
 * 地基复审四 A1：桌面端把 `app.getAppPath()` 当成了仓库根。那个值是**入口所在目录**——
 * `electron .` 从 `apps/desktop` 起就是 `apps/desktop`，打包后是 `resources/app.asar`。
 * 于是 27 条自改红线全部拼成 `<apps/desktop>/packages/kernel/src/policy/**` 这种
 * 不存在的路径，在真实运行里一次也不会命中，而用例喂的是合成的 `/repo`，全绿。
 *
 * 所以锚点不能靠调用方"知道该传什么"，得靠**在磁盘上认出那棵树**。
 *
 * ── 标记选它们三个的理由 ──
 *
 * 三个一起看，才能既认出自己、又不误判别人的仓库：
 *
 *   · `pnpm-workspace.yaml`                        —— 是一个 pnpm monorepo
 *   · `packages/kernel/src/policy/defaults.ts`     —— 这个 monorepo 里有小明的判定逻辑
 *   · `apps/desktop`                               —— 且有小明的外壳
 *
 * 三个都在，才算"这是小明的一份检出"。少一个就可能是任何别的仓库，
 * 而误判的代价是往用户的项目上扣一族禁写红线。
 *
 * 同一个函数也用来判断**会话的工作目录是不是另一份检出**（`extraSourceRoots`），
 * 所以它导出——那是"用打包版小明去改一份 clone"这个真实自改场景的唯一入口。
 */
export function findSourceRoot(start: string): string | undefined {
  let dir: string;
  try {
    // 它是探测器不是校验器：喂进来的可能是任意一个会话的 cwd，规范化不了就是"不是那棵树"
    dir = normalizedOrThrow(start);
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_SOURCE_ROOT_DEPTH; depth += 1) {
    if (SOURCE_ROOT_MARKERS.every((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = normalizedOrThrow(parent);
  }
  return undefined;
}

/** 三个一起看才算认出小明自己，见 `findSourceRoot` */
const SOURCE_ROOT_MARKERS = [
  'pnpm-workspace.yaml',
  join('packages', 'kernel', 'src', 'policy', 'defaults.ts'),
  join('apps', 'desktop'),
];

/** 往上找几级就放弃。深度有限是为了不让一次误判把整块磁盘走一遍 */
const MAX_SOURCE_ROOT_DEPTH = 12;
