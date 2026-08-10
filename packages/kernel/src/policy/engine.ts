import type {
  PermissionRequest,
  PermissionTier,
  PolicyRule,
  PolicyVerdict,
  RiskLevel,
  TargetKind,
} from '@xm/contracts';
import { targetKindOf } from '@xm/contracts';
import { isPrivateOrReservedIp } from './ip-range.js';
import { normalizeTarget } from './normalize.js';
import { normalizePathPattern } from './target.js';
import type { RuleLayer } from './layer.js';
import type { WinningRule } from './untrusted-downgrade.js';
import { downgradeIfUntrusted, isInformedGrant } from './untrusted-downgrade.js';

export { INJECTION_DOWNGRADE_RULE_ID, capabilityLabel } from './untrusted-downgrade.js';

export type Executor = 'local' | 'container' | 'remote';

export type { RuleLayer, RuleLayerId } from './layer.js';

export interface EvaluateInput {
  readonly request: PermissionRequest;
  /** 自底向上排列：内置 → 用户级 → 项目级 → 会话授权。**后一层胜** */
  readonly layers: readonly RuleLayer[];
  readonly tier: PermissionTier;
  readonly executor?: Executor;
  /**
   * 路径匹配是否忽略大小写。**Windows 必须传 true**：那里 `C:/Windows` 与 `c:/windows`
   * 是同一个目录，而规则匹配是字面量的——不打开这个开关，改一下大小写就绕过了红线。
   *
   * 内核不知道自己跑在哪个平台（ADR-0007：禁 `process.platform`），所以这件事必须由
   * 知道平台的运行时显式告知，而不是内核猜。默认 false = POSIX 语义。
   */
  readonly pathCaseInsensitive?: boolean;
  /**
   * 本会话上下文被不可信内容污染的时刻（`SessionState.untrustedContext.since`，epoch ms）。
   * `undefined` = 尚未污染。
   *
   * 只用于一件事：判断一条会话授权是在污染**之前**还是**之后**做出的
   * （见 `isInformedGrant`）。不传等于"没有任何授权算知情"——**落在保守的那一侧**，
   * 所以忘了传的后果是多问几次，不是少问几次。
   */
  readonly untrustedSince?: number;
  /**
   * **造成本会话污染的那次工具调用**（`SessionState.untrustedContext.callId`）。
   * `undefined` = 尚未污染。
   *
   * 与 `untrustedSince` 必须同源取出。它补的是那条时间比较的一个边界：批准了这次污染
   * 本身的那条授权，时间戳反而早于污染时刻（污点标在 `tool.start`，授权记在更早的
   * `permission.decision`）。见 `isInformedGrant` 条件 ④（ADR-0035）。
   *
   * 同样是不传 = 不算知情，落在保守的那一侧。
   */
  readonly untrustedCallId?: string;
}

export const TIER_FALLBACK_RULE_ID = 'builtin.tier-fallback';
/** 路径目标无法规范化时的合成规则 ID。见下方"失败关闭"。 */
export const INVALID_TARGET_RULE_ID = 'builtin.invalid-target';

/**
 * 权限判定 —— **纯函数**，无 I/O、无状态、无时间依赖。
 *
 * ── 求值顺序 ──
 *
 * ```
 * 0  target 规范化，失败关闭
 * 1  全部层里的 immutable deny（红线）—— 任何层都翻不了
 * 2  自最后一层向前，第一个「有匹配」的层定案；层内 deny > ask > allow，同效果后定义者胜
 * 3  没有任何层匹配 → 档位兜底
 * 4  YOLO：把结论里的 ask 变成 allow —— **跳过 ask，跳不过任何 deny**（docs/09 C5）
 * 5  不可信上下文降级，只作用于不可撤销能力；**且感知档位**（ADR-0035）：
 *      · YOLO + 非严重项 → 不降级（否则第 5 步会把第 4 步刚放行的又打回来问）
 *      · 其余情况 allow→ask；ask→deny 只对严重项，非严重项停在高警示 ask
 * ```
 *
 * ── 第 2 步为什么是「分层」而不是「一张拍平的表」──
 *
 * 上一版把所有规则拍成一个数组，优先级是 `deny > ask > allow` 且**与定义顺序无关**。
 * 那条规矩单看很合理（一条写宽了的 allow 不该悄悄把 ask 放松掉），但它有一个
 * 直到 M1-c 接上审批 UI 才暴露出来的后果：
 *
 *   **任何 allow 都压不过内置的 ask，于是「永久授权」在这个引擎里根本表达不出来。**
 *
 * 内置默认里 `fs.write` / `fs.delete` / `shell.exec` / `git.push` / `net.fetch` …
 * 全是 ask。用户在 `config.json` 里写 `allow fs.write /proj/**`，判定照样 ask——
 * `Config.permission.rules` 的 allow 条目对**所有值得授权的能力**一条都不生效。
 * 用户只能收紧，不能放松，而这件事没有任何地方写着。
 *
 * 现在的语义是：**后一层覆盖前一层；同一层内仍是 deny > ask > allow。**
 * 「一条写宽了的 allow 不该放松同一批规则里的 ask」这个保护留在层内，
 * 而「我显式配置的东西应该压过出厂默认」这条常识在层间成立。
 *
 * 红线仍然在分层之前、全局最先判——它是唯一不参与层序的东西，也必须是。
 *
 * 之所以做成纯函数：它是安全边界，必须能被穷举测试。任何 I/O 都会让"把规则优先级
 * 的所有组合跑一遍"变成不可能，而那正是唯一能证明它对的方式。
 */
export function evaluate(input: EvaluateInput): PolicyVerdict {
  const { request, layers, tier } = input;

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

  /*
   * 2) 自最后一层向前：第一个有匹配的层定案，层内 deny > ask > allow
   *
   * 顺带记下**是哪一层的哪条规则定的案**（`winner`）。第 5 步要用它区分
   * "用户当场针对这个目标点的允许"和"配置文件里一条泛化的允许"——两者都是 allow，
   * 对注入防御的意义却完全相反（见 `isInformedGrant`）。
   */
  let verdict: PolicyVerdict | undefined;
  let winner: WinningRule | undefined;
  for (let i = matchedPerLayer.length - 1; i >= 0 && verdict === undefined; i--) {
    const matched = matchedPerLayer[i] ?? [];
    if (matched.length === 0) continue;
    const layerId = layers[i]?.id ?? 'builtin';

    const deny = lastWhere(matched, (r) => r.effect === 'deny');
    // deny 直接定案：YOLO 与后续步骤都越不过它（用户自己写的 deny 同样算数，docs/09 C5）
    if (deny !== undefined) return denyOf(deny);

    const ask = lastWhere(matched, (r) => r.effect === 'ask');
    if (ask !== undefined) {
      verdict = { effect: 'ask', ruleId: ask.id, reason: ask.reason, risk: request.risk };
      winner = { rule: ask, layerId };
      break;
    }

    const allow = lastWhere(matched, (r) => r.effect === 'allow');
    if (allow !== undefined) {
      verdict = { effect: 'allow', ruleId: allow.id, reason: allow.reason };
      winner = { rule: allow, layerId };
    }
  }

  // 3) 档位兜底。YOLO 没有自己的兜底档，它借平衡档的结论再走第 4 步
  verdict ??= tierFallback(tier === 'yolo' ? 'balanced' : tier, request.risk);

  /*
   * 4) YOLO —— **跳过 ask，不跳过 deny**（docs/09 C5 定稿）。
   *
   * 它之前排在普通 deny 之前，效果是 YOLO 把**用户自己写下的 deny 规则**也一并忽略了。
   * 实测：用户写 `deny fs.delete /home/ming/work/prod/**`，balanced 档 DENY，yolo 档 ALLOW。
   *
   * 那个语义站不住。YOLO 的意思是"别再问我了"，不是"忘掉我说过不许碰的地方"——
   * 前者省的是确认框，后者删的是用户唯一能表达"这里绝对不行"的手段。
   * 而且它恰好在最危险的时候失效：用户开 YOLO 正是因为要放手让它长时间自己跑。
   *
   * 放在这里而不是更早，是为了让 `ruleId` 仍然指向**那条本来要问的规则**：
   * 审计里"YOLO 跳过了 def.fs-delete"比"YOLO 默认放行"有用得多。
   */
  if (tier === 'yolo' && verdict.effect === 'ask') {
    verdict = {
      effect: 'allow',
      ruleId: verdict.ruleId,
      reason: `YOLO 档：跳过确认（${verdict.reason}）`,
    };
  }

  /*
   * 5) 注入降级。ask 也要过——默认规则里 git.push / fs.delete / net.fetch 本来就是 ask，
   *    不在这里过一遍，注入降级就永远碰不到最该拦的那批操作。
   *
   * 两个例外，都是为了消掉**零安全价值的重复提问**：
   *
   *   · **知情授权**（ADR-0034）：用户在污染之后、针对这个具体目标当场点过的允许
   *     不再被打回——否则同一个域名会被无限次重复询问，问的是同一个问题。
   *   · **档位**（ADR-0035）：用户开着「帮我批准」/「完全访问权限」时，非严重项
   *     不再降级——否则这一步会把第 4 步刚放行的东西整批打回，"别问我"这个开关
   *     对不可撤销操作**整体失效**，一次联网搜索就是十几个确认框。
   *
   * `tier` 原样传下去而不是在这里分支：降级矩阵（档位 × 严重项 × allow/ask）
   * 是一件事，摊在两个文件里迟早会分叉。
   */
  return downgradeIfUntrusted(
    verdict,
    request,
    isInformedGrant(winner, input.untrustedSince, input.untrustedCallId),
    tier,
  );
}

function tierFallback(tier: Exclude<PermissionTier, 'yolo'>, risk: RiskLevel): PolicyVerdict {
  if (tier === 'strict') {
    return {
      effect: 'ask',
      ruleId: TIER_FALLBACK_RULE_ID,
      reason: '严格档：没有明确规则的操作一律询问',
      risk,
    };
  }
  // balanced：只有明确无害的才默认放行（ADR-0003）
  return risk === 'safe'
    ? { effect: 'allow', ruleId: TIER_FALLBACK_RULE_ID, reason: '平衡档：无风险操作默认放行' }
    : {
        effect: 'ask',
        ruleId: TIER_FALLBACK_RULE_ID,
        reason: '平衡档：非无风险操作需要确认',
        risk,
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
