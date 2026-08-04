import type {
  Capability,
  PermissionRequest,
  PermissionTier,
  PolicyRule,
  PolicyRuleSet,
  PolicyVerdict,
  RiskLevel,
} from '@xm/contracts';
import { isIrreversible } from '@xm/contracts';

export type Executor = 'local' | 'container' | 'remote';

export interface EvaluateInput {
  readonly request: PermissionRequest;
  /** 内置默认 + 用户级 + 项目级，按该顺序拼接。同优先级内**后定义者胜** */
  readonly rules: PolicyRuleSet;
  readonly tier: PermissionTier;
  readonly executor?: Executor;
}

/** 注入降级用的合成规则 ID。出现在 Verdict 里时，UI 要说明"因为上下文含不可信内容" */
export const INJECTION_DOWNGRADE_RULE_ID = 'builtin.injection-downgrade';
export const TIER_FALLBACK_RULE_ID = 'builtin.tier-fallback';

/**
 * 权限判定 —— **纯函数**，无 I/O、无状态、无时间依赖。
 *
 * 求值顺序：`deny(immutable)` → `deny` → `ask` → `allow`，同优先级内**后定义者胜**
 * （所以项目配置能覆盖用户配置：拼接时放在后面即可）。
 *
 * 无匹配规则时由档位兜底。红线（immutable）**不受档位影响**，YOLO 也一样。
 *
 * 之所以做成纯函数：它是安全边界，必须能被穷举测试。任何 I/O 都会让"把规则优先级
 * 的所有组合跑一遍"变成不可能，而那正是唯一能证明它对的方式。
 */
export function evaluate(input: EvaluateInput): PolicyVerdict {
  const { request, rules, tier } = input;
  const matched = rules.filter((r) => matches(r, input));

  // 1) 红线：不可覆盖
  const immutableDeny = lastWhere(matched, (r) => r.effect === 'deny' && r.immutable);
  if (immutableDeny !== undefined) return denyOf(immutableDeny);

  // YOLO 只跳过后续的普通规则，跳不过红线
  if (tier === 'yolo') {
    return downgradeIfUntrusted(
      { effect: 'allow', ruleId: TIER_FALLBACK_RULE_ID, reason: 'YOLO 档：默认放行' },
      request,
    );
  }

  // 2) 普通 deny
  const deny = lastWhere(matched, (r) => r.effect === 'deny');
  if (deny !== undefined) return denyOf(deny);

  // 3) ask
  const ask = lastWhere(matched, (r) => r.effect === 'ask');
  if (ask !== undefined) {
    return { effect: 'ask', ruleId: ask.id, reason: ask.reason, risk: request.risk };
  }

  // 4) allow
  const allow = lastWhere(matched, (r) => r.effect === 'allow');
  if (allow !== undefined) {
    return downgradeIfUntrusted(
      { effect: 'allow', ruleId: allow.id, reason: allow.reason },
      request,
    );
  }

  // 5) 档位兜底
  return downgradeIfUntrusted(tierFallback(tier, request.risk), request);
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

/**
 * 提示词注入降级（ADR-0003 / docs/06）。
 *
 * 只作用于**不可撤销**的能力子集：数据发出去、文件删掉、提交推上去之后，还原点救不回来。
 * 对其余能力做全局收紧会误触发到被用户整体关掉，等于这道防御不存在。
 */
function downgradeIfUntrusted(verdict: PolicyVerdict, request: PermissionRequest): PolicyVerdict {
  if (verdict.effect !== 'allow') return verdict;
  if (request.trustLevel !== 'untrusted') return verdict;
  if (!isIrreversible(request.capability)) return verdict;

  return {
    effect: 'ask',
    ruleId: INJECTION_DOWNGRADE_RULE_ID,
    reason:
      `本轮上下文包含不可信内容（网页 / MCP 返回 / 子 Agent 结果），` +
      `而「${capabilityLabel(request.capability)}」不可撤销，因此需要你确认。`,
    risk: request.risk,
  };
}

const denyOf = (r: PolicyRule): PolicyVerdict => ({
  effect: 'deny',
  ruleId: r.id,
  reason: r.reason,
});

function matches(rule: PolicyRule, input: EvaluateInput): boolean {
  const { request, executor } = input;

  if (rule.capability !== '*' && rule.capability !== request.capability) return false;
  if (rule.match === undefined) return true;

  if (rule.match.target !== undefined && !globMatch(rule.match.target, request.target)) {
    return false;
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
 * 极简 glob。刻意不引入 minimatch 之类的依赖——内核零依赖，且我们只需要三种通配：
 *   `**` 跨分隔符匹配任意字符
 *   `*`  匹配任意字符但不跨 `/`
 *   `?`  匹配单个非 `/` 字符
 *
 * 注意：这是**安全边界**上的匹配。语义越少越好——花哨的 glob 特性（`{a,b}`、`!`）
 * 会让"这条规则到底管不管这个路径"变得难以推理，而推理错误在这里等于放行。
 */
export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

const GLOB_CACHE = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
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

  const re = new RegExp(out);
  GLOB_CACHE.set(pattern, re);
  return re;
}

const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  'fs.delete': '删除文件',
  'shell.exec': '执行命令',
  'process.spawn': '启动进程',
  'net.fetch': '访问网络',
  'net.listen': '监听端口',
  'git.write': '修改 git 仓库',
  'git.push': '推送到远端',
  'env.read': '读取环境变量',
  'secrets.read': '读取密钥',
  'gui.capture': '截取屏幕',
  'gui.input': '注入鼠标键盘',
  'browser.control': '控制浏览器',
  'package.install': '安装依赖包',
  'system.settings': '修改系统设置',
  'plugin.install': '安装插件',
  'self.modify': '修改小明自身代码',
};

export const capabilityLabel = (c: Capability): string => CAPABILITY_LABELS[c];
