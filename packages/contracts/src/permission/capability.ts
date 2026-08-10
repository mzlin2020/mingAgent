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
  /*
   * `shell.exec` 不在这张表里，因为它的内容会被 `analyzeArgv`（ADR-0026）拆成更细的
   * claim（`fs.delete`/`net.fetch`/…），真正不可逆的部分由那些 claim 自己标记。
   * `shell.session`（ADR-0031）刻意**不**做这种拆解——打开会话时的粗粒度 ask 是唯一
   * 判断点，write/resize/close 声明空能力集，此后完全不再判权。如果不把它算进这张表，
   * 提示词注入降级（ADR-0003/0017）在 PTY 这条路径上就形同虚设：会话被读入过不可信
   * 内容后，"打开一个能做任何事的终端"这个操作反而不会被降级。
   */
  'shell.session',
];

export const isIrreversible = (c: Capability): boolean => IRREVERSIBLE_CAPABILITIES.includes(c);

/**
 * 不可信上下文下的**严重项** —— 注入降级里"哪怕用户已经说了别问我，也还是要问"的那一小撮
 * （ADR-0035）。
 *
 * ── 这张表存在的理由 ──
 *
 * 注入降级排在 `evaluate()` 的最后一步，在 YOLO 之后。后果是用户开了「帮我批准」/
 * 「完全访问权限」，第一次 `web.fetch` 把会话污染掉之后，**每一个新域名仍然弹一个框**——
 * 一次新闻搜索就是十几次"允许"。这是用户第三次报同一个形状的反馈，
 * 而这种噪音不换来安全：它只训练人闭着眼点允许（`turn.ts` 自己写着这句话）。
 *
 * 修法不是把整道防御关掉，而是承认"别问我"这个开关对**绝大多数**不可撤销操作是
 * 一次有效的预先回答，只对那些"一旦发生就跨出本机、超出本会话"的少数几件事保留提问。
 *
 * ── 为什么恰好是这三个，不多也不少 ──
 *
 * 少了不行：这三件事的共同点是**后果留在本会话之外**——推上去的提交撤不回、
 * 装上的包会一直执行、改掉的系统设置关掉小明也还在。一个网页说服模型做了它们，
 * 用户回过神来时已经没有现场可以恢复。
 *
 * 多了也不行：`IRREVERSIBLE_CAPABILITIES` 里的其余成员分两类，都不该进来——
 *
 *   · `net.fetch` / `fs.delete` / `shell.session` / `net.listen`
 *     正是用户开 YOLO 时明确表示"这一段时间别问我"的日常操作。把它们留在表里，
 *     等于这个开关照旧不生效，也就是这张表要解决的那个问题原样还在。
 *   · `gui.input` / `plugin.install`（以及不在不可撤销表里的 `secrets.read`）
 *     在不可信上下文下**已经是红线硬拒绝**（`red.*-untrusted`，见 policy/defaults.ts），
 *     红线在第 1 步就定案，根本走不到注入降级那一步。把它们写进来只会造成
 *     "这里也管着"的错觉，而两处表达同一条规则迟早会分叉。
 *
 * 同一张表还有第二个用法：`ask → deny` 那一半（ADR-0017）**只对这三项保留**。
 * 其余能力在默认档下从硬 `deny` 放宽成一个指名污染源的高警示 `ask`，
 * 好让用户能当场只授权一个域名，而不是被迫去解除整轮的不可信标记那个大得多的锤子。
 */
export const CRITICAL_UNDER_UNTRUSTED: readonly Capability[] = [
  'git.push',
  'package.install',
  'system.settings',
];

export const isCriticalUnderUntrusted = (c: Capability): boolean =>
  CRITICAL_UNDER_UNTRUSTED.includes(c);

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
 *   · `command` **契约尚未落地**。带非空 target 的判定一律 deny，
 *                带 `match.target` 的规则在构造期抛错。见 ADR-0020 决策三
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
   * `shell.session` 的 target 是打开会话时的 cwd，不是命令行——它复用路径类的既有
   * 规范化/红线管道来判"在哪打开"，但不覆盖"打开后敲了什么"（ADR-0031，判权设计②）。
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
