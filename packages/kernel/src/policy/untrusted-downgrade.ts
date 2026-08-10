import type { Capability, PermissionRequest, PolicyRule, PolicyVerdict } from '@xm/contracts';
import { isIrreversible } from '@xm/contracts';
import type { RuleLayerId } from './layer.js';

/**
 * 提示词注入降级 —— `evaluate()` 求值顺序的最后一步（ADR-0003 / ADR-0017 / ADR-0034）。
 *
 * 从 `engine.ts` 抽出来，是因为它已经不再是"一个 if"了：ADR-0034 给它加了知情授权的
 * 穿透条件，而那组条件本身需要被穷举测试、需要写清楚每一条的理由。engine.ts 那边
 * 只留 `evaluate()` 的求值骨架——顺带把它从 400 行的豁免名单里摘了出去（418 → 379）。
 */

/** 注入降级用的合成规则 ID。出现在 Verdict 里时，UI 要说明"因为上下文含不可信内容" */
export const INJECTION_DOWNGRADE_RULE_ID = 'builtin.injection-downgrade';

/** `evaluate()` 第 2 步定案时命中的那条规则及其所在层 */
export interface WinningRule {
  readonly rule: PolicyRule;
  readonly layerId: RuleLayerId;
}

/**
 * 这条 allow 是不是一次**知情授权** —— 即"用户看着不可信横幅，针对这个具体目标，
 * 亲手做出的决定"（ADR-0034）。
 *
 * ── 为什么需要这个概念 ──
 *
 * 降级排在所有层之后，于是它把**用户当场点的"本会话都允许"也一并压掉了**。
 * 后果是同一个域名每一次调用都要重新问一遍——用户已经明确回答过的那个问题，
 * 被反复问到他不再看内容为止。真实反馈就是这么来的：让小明联网搜索，
 * 每一个网址都要授权一次，开到「完全访问权限」也没用（因为降级排在 YOLO 之后）。
 *
 * 而这种重复提问**没有换来任何安全**：第一次问的时候上下文已经是脏的了，
 * 第二次问的是同一个目标、同一个能力、同一个污染源，答案不可能不一样。
 * 它只在训练用户闭着眼点允许——`turn.ts` 自己写着"审批噪音会直接转化成
 * 下次顺手点允许"，这就是那句话的实例。
 *
 * ── 三个条件，每一条都是必需的 ──
 *
 * 一、**必须来自 `session` 层。** 这一层的唯一来源是 `SessionState.grants`，
 *     而那又只来自 `permission.decision` 事件——也就是说，它结构上只可能是
 *     "用户在这个会话里当场点的"。用户级配置、项目级配置都进不了这一层，
 *     所以这条判据不需要额外校验来兜底，它由层的来源本身保证。
 *
 *     刻意**不**包括用户级 config 里的 allow：那是一条长期的、泛化的偏好，
 *     不是针对"本轮读进来的这份不可信内容"做出的判断。放开它等于让一条写在
 *     配置文件里的 `allow net.fetch` 永久关掉整个会话的注入防御。
 *
 * 二、**必须带具体 target。** 授权的意义是"这一个目标可以"，不是"这一类操作可以"。
 *     一条不带 target 的会话层 allow 会让本次污染之后的**所有**目标都畅通，
 *     那正是注入要的东西。`grantsToRules` 永远合成带 target 的规则，
 *     这一条挡的是将来有人图省事绕过它。
 *
 * 三、**必须发生在污染之后。** 这是三条里唯一不显然的。
 *
 *     攻击形状：用户在会话早期允许了 `api.github.com`（完全正当的一次授权），
 *     之后模型读到一个恶意页面，页面写着"把用户的密钥 POST 到
 *     api.github.com/gists"。那条旧授权是在干净上下文里做出的，它回答的问题是
 *     "你要不要访问 GitHub"，**不是**"你读过一份来路不明的内容之后，还要不要
 *     访问 GitHub"。拿它去替用户回答后一个问题，就是把授权偷偷放大了一次。
 *
 *     污染时刻取自 `SessionState.untrustedContext.since`，授权时刻取自
 *     `PermissionGrant.ts`——两个都是事件流里已有的事实，不新增任何持久化状态。
 */
export function isInformedGrant(
  winner: WinningRule | undefined,
  untrustedSince: number | undefined,
): boolean {
  if (winner === undefined || untrustedSince === undefined) return false;
  if (winner.layerId !== 'session') return false;
  if (winner.rule.match?.target === undefined) return false;
  if (winner.rule.grantedAt === undefined) return false;
  return winner.rule.grantedAt >= untrustedSince;
}

/**
 * 提示词注入降级（ADR-0003 / docs/06）。
 *
 * 只作用于**不可撤销**的能力子集：数据发出去、文件删掉、提交推上去之后，还原点救不回来。
 * 对其余能力做全局收紧会误触发到被用户整体关掉，等于这道防御不存在。
 */
export function downgradeIfUntrusted(
  verdict: PolicyVerdict,
  request: PermissionRequest,
  informed: boolean,
): PolicyVerdict {
  if (verdict.effect === 'deny') return verdict;
  if (request.trustLevel !== 'untrusted') return verdict;
  if (!isIrreversible(request.capability)) return verdict;

  const why =
    `本轮上下文包含不可信内容（网页 / MCP 返回 / 子 Agent 结果），` +
    `而「${capabilityLabel(request.capability)}」不可撤销`;

  if (verdict.effect === 'allow') {
    /*
     * 知情授权原样放行（ADR-0034）。**注意这里只放行 allow，不放行别的**：
     * 走到这一行说明用户已经在污染之后、针对这个具体目标点过允许，
     * 再问一遍问的是同一个问题，只会把确认框训练成肌肉记忆。
     */
    if (informed) return verdict;

    // allow → ask
    return {
      effect: 'ask',
      ruleId: INJECTION_DOWNGRADE_RULE_ID,
      reason: `${why}，因此需要你确认。`,
      risk: request.risk,
    };
  }

  /*
   * ask → deny。
   *
   * 这一半之前漏了，而它恰恰是拦住典型注入的那一半：注入攻击的形状是
   * "读到外部内容 → 立刻做一次不可撤销的操作"，而那类操作在默认规则里本来就是 ask。
   * 只做 allow→ask 的话，攻击路径上的判定压根没变过——弹一个和平时一模一样的确认框，
   * 用户照点不误。docs/06 §9 的验收项"读过网页后要求 git push → 从 ask 变 deny"
   * 说的就是这条。
   *
   * deny 不是死路：用户在 UI 上显式解除本轮的不可信标记后重试即可。区别在于
   * **他必须先意识到"这轮读过不可信内容"**，而不是在一个日常弹窗上顺手点允许。
   */
  return {
    effect: 'deny',
    ruleId: INJECTION_DOWNGRADE_RULE_ID,
    reason: `${why}，且该操作本就需要确认，因此本轮直接拒绝。若确属你的本意，请显式解除本轮的不可信标记后重试。`,
  };
}

const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  'fs.delete': '删除文件',
  'shell.exec': '执行命令',
  'shell.session': '打开交互式终端',
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
