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

export function resolvePaths(options: ResolvePathsOptions): XmPaths {
  const name = options.appName ?? 'xiaoming';
  const base = envPaths(name, { suffix: '' });

  /*
   * 全部过一遍 normalizedOrThrow，得到的是**与红线规则同一个坐标系**的路径：
   * 分隔符统一成 `/`、盘符大写、无尾斜杠。
   *
   * 这一步不是洁癖。ADR-0012 ① 的失效就是这么发生的：红线里存的是一种写法，
   * 请求里传的是另一种写法，两边都"是路径"，匹配却永远不命中，而输出一直是"规则已配置"。
   * 现在两边都从这里出发，形状上就没有分叉的机会。
   */
  return {
    home: normalizedOrThrow(options.home ?? homeDir()),
    appRoot: normalizedOrThrow(options.appRoot),
    data: normalizedOrThrow(options.dataDir ?? base.data),
    config: normalizedOrThrow(base.config),
    cache: normalizedOrThrow(base.cache),
    logs: normalizedOrThrow(base.log),
  };
}
