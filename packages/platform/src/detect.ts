import { homedir } from 'node:os';
import type { OsFamily } from '@xm/kernel';

/**
 * **全仓库唯一允许读 `process.platform` 与 `node:os` 的文件。**
 *
 * 放行是在 `eslint.config.js` 里按文件路径开的口子，不是行内 `eslint-disable`——
 * 行内注释会跟着复制粘贴一起扩散，而路径白名单扩散不了：多一个文件就要多改一次配置，
 * 那次改动在 code review 里看得见。ADR-0007 保险 1 要的是"加平台 = 写一个适配器"，
 * 不是"到处考古 `process.platform`"。
 *
 * 这个文件本身刻意保持只有几行：它越薄，白名单的代价越小。
 */

export function osFamily(): OsFamily {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      // Linux 与其它 Unix 一律按 Linux 处理（Tier 2 基线：Ubuntu LTS + GNOME）。
      // 真跑在 FreeBSD 上时路径与能力探测的结论与 Linux 相同，没必要多一个分支。
      return 'linux';
  }
}

export function homeDir(): string {
  return homedir();
}

/**
 * 显示服务器。仅 Linux 有意义，用于判断能不能做输入注入（ADR-0007 Tier 3）。
 *
 * Wayland 下输入注入是**被设计性禁止**的，只能走 portal / libei，且各合成器支持程度不一。
 * M0-b 不实现注入，但这个判断现在就得在——否则 M4 时会在业务代码里冒出
 * `process.env.WAYLAND_DISPLAY` 的散点判断，正是 PlatformPort 要防的东西。
 */
export function displayServer(): 'x11' | 'wayland' | 'none' | 'n/a' {
  if (osFamily() !== 'linux') return 'n/a';
  if (typeof process.env.WAYLAND_DISPLAY === 'string') return 'wayland';
  if (typeof process.env.DISPLAY === 'string') return 'x11';
  return 'none';
}
