import { z } from 'zod';

/**
 * 能力词表 —— **闭集**。新增能力必须改这里 + 写一份 ADR。
 *
 * 为什么闭集是刻意的：如果能力名是任意字符串，插件就能自造能力名绕过策略。
 * 策略规则匹配不到的能力，默认放行 = 后门，默认拒绝 = 插件全废。
 * 闭集 + 新增走 ADR，是唯一能让 PolicyEngine 的行为可穷举测试的做法。
 */
export const Capability = z.enum([
  'fs.read',
  'fs.write',
  'fs.delete',
  'shell.exec',
  'process.spawn',
  'net.fetch',
  'net.listen',
  'git.write',
  'git.push',
  'env.read',
  'secrets.read',
  'gui.capture',
  'gui.input',
  'browser.control',
  'package.install',
  'system.settings',
  'plugin.install',
  'self.modify',
]);
export type Capability = z.infer<typeof Capability>;

export const ALL_CAPABILITIES: readonly Capability[] = Capability.options;

/**
 * 不可撤销的能力子集。
 *
 * 提示词注入的权限降级（ADR-0003）**只**作用于这些能力：数据一旦发出去、文件一旦删掉、
 * 提交一旦推上去，还原点救不回来。对其余能力做全局收紧会误触发到被用户关掉，
 * 等于这道防御不存在。
 */
export const IRREVERSIBLE_CAPABILITIES: readonly Capability[] = [
  'fs.delete',
  'net.fetch',
  'net.listen',
  'git.push',
  'gui.input',
  'package.install',
  'system.settings',
  'plugin.install',
];

export const isIrreversible = (c: Capability): boolean => IRREVERSIBLE_CAPABILITIES.includes(c);

/**
 * `target` 是**文件系统路径**的能力子集。
 *
 * 这不是分类学，是判定行为的分叉点：对这些能力，`PermissionRequest.target` 必须是
 * **已规范化的绝对路径**，PolicyEngine 会先规范化再匹配，规范化失败**直接拒绝**
 * （见 kernel/policy/target.ts）。
 *
 * 原因是实测出来的：红线写 `~` 而运行时传 `/home/ming`，写 `/` 而运行时传 `/tmp/..`，
 * 两边都是"路径"却对不上，规则看起来在、实际永不命中。字符串 glob 在安全边界上
 * 必须配一个规范化契约，否则拼写差异就是绕过手段。
 */
export const PATH_CAPABILITIES: readonly Capability[] = [
  'fs.read',
  'fs.write',
  'fs.delete',
  'self.modify',
];

export const isPathCapability = (c: Capability): boolean => PATH_CAPABILITIES.includes(c);
