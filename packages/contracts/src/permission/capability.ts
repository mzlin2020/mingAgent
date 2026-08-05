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
 * **把外部内容带进上下文**的能力子集 —— 提示词注入的入口。
 *
 * 这个子集存在的理由，是 M0-b 复审时实测出来的一个洞：`PermissionRequest.trustLevel`
 * 在整个代码库里只被硬编码成过 `'model'`，没有任何一条路径会产出 `'untrusted'`。
 * 于是三条 `red.*-untrusted` 红线与整套注入降级（allow→ask、ask→deny）**一次也不会触发**。
 * 判定逻辑是对的、测试是绿的、防御是不存在的——本项目第七次「规则存在 ≠ 规则生效」。
 *
 * 修法的关键是**别让人去记**。`trustLevel` 不该由调用方填，而应该从事件流里**算**出来：
 * 一旦本会话执行过带这些能力的工具，上下文里就有了外部内容，此后一律按不可信处理
 * （见 kernel/state/reduce.ts 的 `untrustedContext`）。工具声明了能力就自动生效，
 * 装配方忘不了，因为根本没有让它填的地方。
 *
 * ── 为什么是这三个，不多也不少 ──
 *
 * 多了会自毁：`fs.read` 也可能读到别人写的文件，但它在平衡档默认放行且几乎每轮都发生，
 * 把它算进来等于会话一开始就永久不可信，用户会直接关掉整道防御——那才是真的没有防御。
 * 少了会漏：`gui.capture` 看似只是截图，但截的如果是一个浏览器窗口，
 * 它和 `net.fetch` 拿回来的是同一段攻击载荷，只是换了条路进来。
 *
 * ⚠️ 已知不覆盖的两条路，见 docs/09：MCP 工具若不声明 `net.fetch` 就标不出来；
 * 子 Agent 的不可信标记目前不会传染回父会话。
 */
export const UNTRUSTED_CONTENT_CAPABILITIES: readonly Capability[] = [
  'net.fetch',
  'browser.control',
  'gui.capture',
];

export const isUntrustedContentSource = (c: Capability): boolean =>
  UNTRUSTED_CONTENT_CAPABILITIES.includes(c);

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
