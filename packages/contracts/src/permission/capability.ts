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
  'shell.session',
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

/*
 * ── 这里曾经有两张表：`IRREVERSIBLE_CAPABILITIES` 与 `CRITICAL_UNDER_UNTRUSTED` ──
 *
 * 两张都只为**注入降级**（`kernel/policy/untrusted-downgrade.ts`）服务，而注入降级的
 * 全部输出是"把 allow 改成 ask、把 ask 改成 deny"。ADR-0039 把 `ask` 整个从判定结果里
 * 去掉之后，这套"降一档再问一次"的机制没有了落点：能表达的只有 allow 与 deny。
 *
 * 它们要保护的东西**没有丢**，而是换成了声明式的规则——「后果留在本会话之外」那条判据
 * （ADR-0035 论证过的 `git.push` / `package.install` / `system.settings`）现在写成
 * `policy/defaults.ts` 里三条 `match: { trustLevel: ['untrusted'] }` 的 deny，
 * 与早就存在的 `red.*-untrusted` 红线同一个形状。
 *
 * **一条规则只在一个地方表达**：判据留在规则表里，不再额外维护一份能力清单。
 */

/**
 * **把外部内容带进上下文**的能力子集 —— 提示词注入的入口。
 *
 * 这个子集存在的理由，是 M0-b 复审时实测出来的一个洞：`PermissionRequest.trustLevel`
 * 在整个代码库里只被硬编码成过 `'model'`，没有任何一条路径会产出 `'untrusted'`。
 * 于是所有 `match: { trustLevel: ['untrusted'] }` 的规则（当时是三条 `red.*-untrusted`
 * 红线，ADR-0039 之后又多了三条污染上下文 deny）**一次也不会触发**。
 * 判定逻辑是对的、测试是绿的、防御是不存在的——本项目第七次「规则存在 ≠ 规则生效」。
 *
 * 这个子集因此比它看上去重要得多：**它是整条不可信链路唯一的起点。**
 * 它算不出 `'untrusted'`，下游六条规则就全是死规则。
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
 * ⚠️ MCP 仍未落地：三方工具若能自行决定是否声明 `net.fetch`，就可能漏标，因此注册闸门
 * 在 M3 完成可信污点来源前继续失败关闭。子 Agent 已在 ADR-0049 中通过
 * `subagent.end.untrustedContext` 把末态污点粘性并回父会话。
 */
export const UNTRUSTED_CONTENT_CAPABILITIES: readonly Capability[] = [
  'net.fetch',
  'browser.control',
  'gui.capture',
  /*
   * 终端里 `curl`/`cat` 之类回显的内容，一旦被模型读回上下文，与 `net.fetch` 拿回来的
   * 是同一段潜在攻击载荷，只是换了条路进来（ADR-0031）。
   */
  'shell.session',
];

export const isUntrustedContentSource = (c: Capability): boolean =>
  UNTRUSTED_CONTENT_CAPABILITIES.includes(c);

/**
 * `PermissionRequest.target` 的语义 —— **每个能力恰好一种**（ADR-0020，定案 docs/09 C4）。
 *
 * 契约里 target 是一个 `string`，判定统一走 glob。但各能力的 target 根本不是同一种东西：
 * `fs.*` 是路径、`net.fetch` 是网络目的地、`shell.exec` 是命令行、`secrets.read` 是键名。
 * 用同一套字面量匹配去管四种东西，结果是**其中三种上的规则只是看起来在生效**。
 *
 * 路径这一种在 ADR-0012 ① 已经付过一次学费（红线写 `~`、请求传 `/home/ming`，永不命中），
 * 修法是规范化 + 失败关闭。这张表把那个修法推广到其余三种，并且把「哪一种还没有契约」
 * 变成一件写在类型里、拿得出来说的事：
 *
 *   · `path`    已规范化的绝对路径。规范化失败 → **deny**（kernel/policy/target.ts）
 *   · `host`    http(s) URL，归一成 `host[:port]`。归一失败 → **deny**（host-target.ts）
 *   · `command` 结构化 `{argv,cwd}` 的规范串已落地；依赖运行时展开的构造失败关闭。
 *                规范串本身仍不是安全边界，真正防线是 argv 拆出的路径/主机主张
 *   · `opaque`  自由字符串（键名、远端名、设置项）。**不是安全边界**，
 *                只能当便利过滤——红线不许建立在它上面，由 builtinRules 构造期断言
 *
 * 写成 `Record<Capability, TargetKind>` 而不是几个数组：**新增能力时不做这个决定就
 * 编译不过**。与 `CAPABILITY_LABELS` 同一个手法，理由也相同——闭集的价值全在
 * "漏掉一个会当场炸"上，一旦退化成"漏掉一个就默认按某种处理"，闭集就白设了。
 */
export type TargetKind = 'path' | 'host' | 'command' | 'opaque';

const TARGET_KINDS: Readonly<Record<Capability, TargetKind>> = {
  'fs.read': 'path',
  'fs.write': 'path',
  'fs.delete': 'path',
  'self.modify': 'path',

  'net.fetch': 'host',
  'browser.control': 'host',

  'shell.exec': 'command',
  'process.spawn': 'command',

  /*
   * `shell.session` 的 target 是 open 时的 cwd，复用路径类规范化/红线管道。
   * 模型没有原始 stdin；后续 `shell.session.run` 另声明 `shell.exec`，逐次判 argv（ADR-0040）。
   */
  'shell.session': 'path',

  /*
   * `net.listen` 刻意**不是** host。它的 target 是本机的绑定地址（`0.0.0.0:8080`），
   * 与"要访问哪个远端"是相反方向的东西，塞进 URL 归一里只会得到一个错误的答案。
   * 绑定地址自己的规范化契约要等到真有监听类工具时再定。
   */
  'net.listen': 'opaque',
  'git.write': 'opaque',
  'git.push': 'opaque',
  'env.read': 'opaque',
  'secrets.read': 'opaque',
  'gui.capture': 'opaque',
  'gui.input': 'opaque',
  'package.install': 'opaque',
  'system.settings': 'opaque',
  'plugin.install': 'opaque',
};

export const targetKindOf = (c: Capability): TargetKind => TARGET_KINDS[c];

/**
 * `target` 是文件系统路径的能力子集。**从上表推导**，不另外维护一份列表——
 * 两份列表必然分叉，而分叉的表现是某个能力悄悄换了判定语义。
 */
export const PATH_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (c) => TARGET_KINDS[c] === 'path',
);

export const isPathCapability = (c: Capability): boolean => targetKindOf(c) === 'path';
