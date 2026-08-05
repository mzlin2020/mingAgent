import { realpathSync } from 'node:fs';
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
  /** 小明自身仓库/安装目录。**不在包内猜**：桌面传 `app.getAppPath()`，headless 由入口决定 */
  readonly appRoot: string;
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
  return {
    home: norm(options.home ?? homeDir()),
    appRoot: norm(options.appRoot),
    data: norm(options.dataDir ?? base.data),
    config: norm(base.config),
    cache: norm(base.cache),
    logs: norm(base.log),
  };
}
