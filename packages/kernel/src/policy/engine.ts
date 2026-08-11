import type {
  PermissionRequest,
  PolicyRule,
  PolicyRuleSet,
  PolicyVerdict,
  TargetKind,
} from '@xm/contracts';
import { targetKindOf } from '@xm/contracts';
import { isPrivateOrReservedIp } from './ip-range.js';
import { normalizeTarget } from './normalize.js';
import { normalizePathPattern } from './target.js';

export type Executor = 'local' | 'container' | 'remote';

/**
 * 规则的来源层。**顺序即优先级**，见 `evaluate()` 的求值顺序说明。
 *
 * 层名不只是标签：`project` 层被限制为只能收紧（`layers.ts` 的 `tightenOnly`），
 * 因为那个文件躺在别人写的仓库里。
 *
 * 这两个类型曾经单独住在 `layer.ts`，为的是拆开 `engine.ts` 与 `untrusted-downgrade.ts`
 * 之间一个真实的循环依赖（后者要判断定案规则来自哪一层，只有 `session` 层的授权算
 * "知情"，ADR-0034）。ADR-0039 删掉注入降级与 `session` 层之后环没有了，
 * 类型跟着搬回它唯一的使用者身边——一个只为绕开已经不存在的环而存在的文件，
 * 留着只会让下一个人以为那个环还在。
 */
export type RuleLayerId = 'builtin' | 'user' | 'project';

export interface RuleLayer {
  readonly id: RuleLayerId;
  readonly rules: PolicyRuleSet;
}

export interface EvaluateInput {
  readonly request: PermissionRequest;
  /** 自底向上排列：内置 → 用户级 → 项目级。**后一层胜** */
  readonly layers: readonly RuleLayer[];
  readonly executor?: Executor;
  /**
   * 路径匹配是否忽略大小写。**Windows 必须传 true**：那里 `C:/Windows` 与 `c:/windows`
   * 是同一个目录，而规则匹配是字面量的——不打开这个开关，改一下大小写就绕过了红线。
   *
   * 内核不知道自己跑在哪个平台（ADR-0007：禁 `process.platform`），所以这件事必须由
   * 知道平台的运行时显式告知，而不是内核猜。默认 false = POSIX 语义。
   */
  readonly pathCaseInsensitive?: boolean;
}

/** 没有任何规则匹配时的兜底规则 ID。见下方第 3 步。 */
export const FALLBACK_ALLOW_RULE_ID = 'builtin.no-rule-matched';
/** 路径目标无法规范化时的合成规则 ID。见下方"失败关闭"。 */
export const INVALID_TARGET_RULE_ID = 'builtin.invalid-target';

/**
 * 权限判定 —— **纯函数**，无 I/O、无状态、无时间依赖。
 *
 * ── 求值顺序（ADR-0039 之后只有三步）──
 *
 * ```
 * 0  target 规范化，失败关闭
 * 1  全部层里的 immutable deny（红线）—— 任何层都翻不了
 * 2  自最后一层向前，第一个「有匹配」的层定案；层内 deny > allow，同效果后定义者胜
 * 3  没有任何层匹配 → 放行
 * ```
 *
 * 这里曾经还有两步，都随"问用户"这件事一起消失了：**档位兜底**（strict/balanced/yolo，
 * ADR-0003）与**注入降级**（allow→ask / ask→deny，ADR-0003/0017/0034/0035）。
 * 前者唯一的作用是决定"没有规则匹配时要不要问"，后者的全部输出是"降一档再问一次"——
 * 判定结果里没有 `ask` 之后，两者都没有落点。
 *
 * 注入降级要保护的东西没有丢，改成了 `defaults.ts` 里三条
 * `match: { trustLevel: ['untrusted'] }` 的 deny（判据仍是 ADR-0035 论证过的
 * "后果留不留在本会话之外"），与早就存在的 `red.*-untrusted` 红线同一个形状。
 * **规则表达在规则表里，不在判定函数里** —— 一个后置的、能推翻前面全部结论的
 * 修正步骤，是本项目在 ADR-0034/0035/0036 上连着栽三次的地方。
 *
 * ── 第 2 步为什么是「分层」而不是「一张拍平的表」──
 *
 * 上一版把所有规则拍成一个数组，优先级与定义顺序无关。那条规矩单看很合理
 * （一条写宽了的 allow 不该悄悄把内置的收紧放松掉），但后果是**用户在
 * `config.json` 里写的 allow 对所有值得授权的能力一条都不生效**——只能收紧，
 * 不能放松，而这件事没有任何地方写着（ADR-0023）。
 *
 * 现在的语义是：**后一层覆盖前一层；同一层内 deny 胜 allow。**
 * 「一条写宽了的 allow 不该放松同一批规则里的收紧」这个保护留在层内，
 * 而「我显式配置的东西应该压过出厂默认」这条常识在层间成立。
 *
 * 红线仍然在分层之前、全局最先判——它是唯一不参与层序的东西，也必须是。
 *
 * 之所以做成纯函数：它是安全边界，必须能被穷举测试。任何 I/O 都会让"把规则优先级
 * 的所有组合跑一遍"变成不可能，而那正是唯一能证明它对的方式。
 */
export function evaluate(input: EvaluateInput): PolicyVerdict {
  const { request, layers } = input;

  /*
   * 0) 目标先规范化，**失败关闭**。
   *
   * 必须排在红线之前：规则是按规范化后的形式写的，拿未规范化的字符串去匹配，
   * 命中与否取决于调用方怎么拼这个串——那就不是安全边界，是巧合。
   *
   * 判不了就 deny，不降级成 ask：ask 的下一步是用户点"允许"。
   *
   * 这里以前只管路径（`if (isPathCapability(...))`），其余能力的 target 原样进 glob。
   * 现在按能力的 target 语义分派（ADR-0020）：路径、网络目的地各有各的规范化，
   * 命令行明确地"还没有契约"因而失败关闭，opaque 明确地"不是安全边界"。
   */
  const kind = targetKindOf(request.capability);
  const normalized = normalizeTarget(request.capability, request.target);
  if (!normalized.ok) {
    return {
      effect: 'deny',
      ruleId: INVALID_TARGET_RULE_ID,
      reason: `无法判定该操作的权限：${normalized.reason}`,
    };
  }
  const target = normalized.value;

  const matchedPerLayer = layers.map((layer) =>
    layer.rules.filter((r) => matches(r, input, target, kind)),
  );

  /*
   * 1) 红线：不参与层序，全局最先判。
   *
   * 它是这个函数里唯一"跨层"的一步，也必须是——红线的定义就是"任何档位、任何用户
   * 配置都不可覆盖"，一旦让它进层序，一条更靠后的层就能把它顶掉。
   */
  const immutableDeny = lastWhere(
    matchedPerLayer.flat(),
    (r) => r.effect === 'deny' && r.immutable,
  );
  if (immutableDeny !== undefined) return denyOf(immutableDeny);

  // 2) 自最后一层向前：第一个有匹配的层定案，层内 deny 胜 allow
  for (let i = matchedPerLayer.length - 1; i >= 0; i--) {
    const matched = matchedPerLayer[i] ?? [];
    if (matched.length === 0) continue;

    // deny 直接定案：没有任何后续步骤能翻它（用户自己写的 deny 同样算数，docs/09 C5）
    const deny = lastWhere(matched, (r) => r.effect === 'deny');
    if (deny !== undefined) return denyOf(deny);

    const allow = lastWhere(matched, (r) => r.effect === 'allow');
    if (allow !== undefined) {
      return { effect: 'allow', ruleId: allow.id, reason: allow.reason };
    }
  }

  /*
   * 3) 没有任何规则匹配 → 放行。
   *
   * 这是 ADR-0039 的核心一步，也是整个改动里唯一真正放宽了的地方，所以把话说清楚：
   *
   * 兜底放行**不等于**没有防线。防线是第 1/2 步那张拒绝清单——红线（27 条自改保护、
   * 删根目录、审计日志、不可信上下文下的密钥读/GUI 操作/装插件）、敏感路径不许读
   * （ADR-0025）、持久化路径不许写（ADR-0027）、SSRF 网段（ADR-0028）、
   * 危险命令拆解出的主张（ADR-0026）、以及用户自己写下的任何 deny。
   * 它们一条都没少，而且因为不再有"用户会顺手点允许"这个出口，实际比原来更硬。
   *
   * 兜底选放行而不是拒绝，是因为小明的目标形态是一个基本自主的 agent：
   * 一个"没写规则就干不了"的兜底，等于把闭集之外的一切都变成待办的规则表维护工作，
   * 而那份工作没人做得完——最后的结果一定是有人加一条 `allow *`。
   *
   * `ruleId` 明确写成"没有规则匹配"，不假装是某条规则的功劳：审计里
   * "无规则匹配，默认放行"和"命中 def.fs-write 放行"是完全不同的两件事，
   * 混在一起会让"这条到底是谁放行的"变得查不出来。
   */
  return {
    effect: 'allow',
    ruleId: FALLBACK_ALLOW_RULE_ID,
    reason: '没有任何规则匹配这个操作，默认放行',
  };
}

const denyOf = (r: PolicyRule): PolicyVerdict => ({
  effect: 'deny',
  ruleId: r.id,
  reason: r.reason,
});

function matches(
  rule: PolicyRule,
  input: EvaluateInput,
  target: string,
  kind: TargetKind,
): boolean {
  const { request, executor } = input;

  if (rule.capability !== '*' && rule.capability !== request.capability) return false;
  if (rule.match === undefined) return true;

  if (
    rule.match.target !== undefined &&
    !globMatch(rule.match.target, target, input.pathCaseInsensitive ?? false, kind)
  ) {
    return false;
  }
  if (rule.match.ipRange !== undefined) {
    /*
     * 防御性检查：非 `host` kind 直接判不匹配。构造期 `assertRules()` 已经不让这种规则
     * 建出来，走到这里说明假设被破坏了——不匹配比崩溃更安全，但不该真的发生。
     */
    if (kind !== 'host') return false;
    // target 可能带 `:port`（IPv6 是 `[::1]:8080`），判定只看主机部分
    const host = target.startsWith('[') ? target.slice(0, target.indexOf(']') + 1) : target.split(':')[0] ?? target;
    if (!isPrivateOrReservedIp(host)) return false;
  }
  if (rule.match.executor !== undefined && rule.match.executor !== (executor ?? 'local')) {
    return false;
  }
  if (rule.match.trustLevel !== undefined && !rule.match.trustLevel.includes(request.trustLevel)) {
    return false;
  }
  return true;
}

/** 数组里满足条件的**最后一个**——"同优先级后定义者胜"就落在这一行上 */
function lastWhere<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && pred(item)) return item;
  }
  return undefined;
}

/**
 * 极简 glob。刻意不引入 minimatch 之类的依赖——内核零依赖，且我们只需要四种通配：
 *
 *   `/**` 结尾  匹配该目录**自身**及其下的一切
 *   `**`        跨分隔符匹配任意字符
 *   `*`         匹配任意字符但不跨 `/`
 *   `?`         匹配单个非 `/` 字符
 *   `\x`        转义：把 `x` 当字面量，用于 `\*` / `\?` / `\\`
 *
 * 转义是给**授权**用的（`layers.ts` 的 `escapeGlobPattern`）：一次"允许写这个文件"
 * 的授权，target 是一个字面路径而不是模式。POSIX 上 `a*b` 是合法文件名，
 * 不转义就会让一次针对单个文件的授权匹配到一批文件——授权是会被持久化成规则的，
 * 那个放大会一直留着。内置规则里没有反斜杠，所以这条不影响任何存量模式。
 *
 * 第一条是单独列出来的，因为它是个真实的坑：朴素实现里 `/prod/**` 展开成 `/prod/.*`，
 * 于是**匹配不到 `/prod` 目录本身**——"禁止写 /prod 下的一切"这条规则，对 `/prod`
 * 自己失效。目录本身往往正是最该拦的那个目标（删目录 = 删掉它下面的一切）。
 *
 * `kind === 'host'` 时多一条：**开头的 `*.` 也匹配域名自身**。
 *
 *   `*.evil.com` 命中 `evil.com`、`x.evil.com`，不命中 `notevil.com`
 *
 * 这与上面 `/**` 那一条是同一个坑的同一个决定：朴素实现里 `*.evil.com` 展开成
 * `[^/]*\.evil\.com`，于是"禁止 evil.com 及其子域"这条规则**对 evil.com 自己失效**——
 * 而顶级域名恰恰是最该拦的那个目标。写规则的人不会想到还要单独再写一条。
 *
 * 注意：这是**安全边界**上的匹配。语义越少越好——花哨的 glob 特性（`{a,b}`、`!`）
 * 会让"这条规则到底管不管这个路径"变得难以推理，而推理错误在这里等于放行。
 */
export function globMatch(
  pattern: string,
  value: string,
  caseInsensitive = false,
  kind: TargetKind = 'opaque',
): boolean {
  return globToRegExp(pattern, caseInsensitive, kind).test(value);
}

/**
 * 编译缓存。**有上限** —— 小明是个跑几周不重启的常驻进程，而模块级的 Map 只增不减
 * 就是一条内存泄漏。pattern 来自规则，规则会随着切项目、装插件、接 MCP server 不断换新：
 * 今天规则数量是常数，不代表明天是，而"安全边界上的缓存"恰恰是最不该无界增长的东西。
 *
 * 满了整体清空，不做 LRU：规则集的访问模式是"一批规则反复用"，清空后一轮就重新暖起来，
 * 而 LRU 要在热路径上多维护一份链表状态，不值得。
 */
const GLOB_CACHE_MAX = 1024;
const GLOB_CACHE = new Map<string, RegExp>();

function globToRegExp(pattern: string, caseInsensitive: boolean, kind: TargetKind): RegExp {
  const cacheKey = `${caseInsensitive ? 'i' : 's'} ${kind} ${pattern}`;
  const cached = GLOB_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  /*
   * 路径模式先过一遍坐标系归一：请求的 target 一律是正斜杠 + 大写盘符，
   * 而规则里的模式是用户手写 / 程序合成的原样字符串。两边不在同一个坐标系里，
   * 一条写着 `C:\Users\me\**` 的 deny 规则就是一条**静默失效**的规则。
   * 见 `normalizePathPattern` —— 它只动 Windows 盘符绝对路径，POSIX 模式原样通过。
   */
  const source = kind === 'path' ? normalizePathPattern(pattern) : pattern;

  let out = '^';
  let start = 0;
  // host 语义下开头的 `*.`：子域可有可无，域名自身也算命中（见上方说明）
  if (kind === 'host' && source.startsWith('*.')) {
    out += '(?:[^.]+\\.)*';
    start = 2;
  }

  for (let i = start; i < source.length; i++) {
    const ch = source[i] ?? '';
    if (ch === '\\' && i + 1 < source.length) {
      // 转义：下一个字符按字面量处理，不参与任何通配语义
      out += (source[i + 1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else if (ch === '/' && source[i + 1] === '*' && source[i + 2] === '*' && i + 3 === source.length) {
      // 结尾的 `/**`：目录自身也算命中
      out += '(?:/.*)?';
      i += 2;
    } else if (ch === '*') {
      if (source[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';

  const re = new RegExp(out, caseInsensitive ? 'i' : '');
  if (GLOB_CACHE.size >= GLOB_CACHE_MAX) GLOB_CACHE.clear();
  GLOB_CACHE.set(cacheKey, re);
  return re;
}
