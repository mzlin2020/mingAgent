import type { PolicyRule, PolicyRuleSet } from '@xm/contracts';

/**
 * 规则层的构造 —— ADR-0039 之后只剩一件事：**项目层只能收紧**。
 *
 * `engine.ts` 只负责"给定若干层，判出结果"。层是怎么来的、哪一层可以放松哪一层不行，
 * 全在这个文件里。分开是因为前者是纯判定、要能被穷举测试，后者是一组安全取舍、
 * 每一条都要说得出理由。
 */

// ── 项目层只能收紧 ──────────────────────────────────────────────

export interface TightenOutcome {
  readonly rules: PolicyRuleSet;
  /** 被丢弃的规则 id。调用方必须把它变成一条用户可见的 notice，不许静默 */
  readonly dropped: readonly string[];
}

/**
 * 丢掉一层里所有**放松**权限的规则，只保留 deny。
 *
 * 用在**项目级** `.xiaoming/config.json` 上，理由具体到几乎是一条攻击路径：
 *
 *   · 那个文件躺在用户 clone 下来的仓库里，作者不是用户；
 *   · 小明自己有 `fs.write`，模型完全可以在干活的过程中把它写出来；
 *   · 而层序里项目层排在用户层之后——它要是能放松，就等于"仓库里的一个文件
 *     可以撤销用户的设置"。
 *
 * 这与 `SESSION_FORBIDDEN_CONFIG_PATHS`（会话补丁不许碰 permission / providers）
 * 是同一条纪律的同一个形状：**能被下游写出来的东西，只许收紧，不许放松。**
 *
 * 收紧方向留着是有用的：一个仓库说"这里别乱写"是合理且无害的表达。
 *
 * ⚠️ ADR-0039 之后这道闸门比原来更吃重。以前一条被放进来的 allow 顶多把 ask 变成
 * 不问，现在判定只有 allow/deny 两个值，它顶掉的就是一条真实的拒绝——
 * 而污染上下文下那三条 deny（`untrusted.*`）刻意不是 immutable，正好是它能顶的。
 * 所以这里"只保留 deny"是唯一正确的方向，不要为了"项目也该能配点什么"而放宽。
 */
export function tightenOnly(rules: PolicyRuleSet): TightenOutcome {
  const kept: PolicyRule[] = [];
  const dropped: string[] = [];
  for (const r of rules) {
    if (r.effect === 'allow') dropped.push(r.id);
    else kept.push(r);
  }
  return { rules: kept, dropped };
}

/*
 * ── 这里曾经有 `grantsToRules()` / `escapeGlobPattern()` / `GRANT_RULE_PREFIX` ──
 *
 * 它们把用户在审批卡片上点的"本会话都允许"/"永久允许"合成成 `session` 层的规则。
 * ADR-0039 删掉审批之后，那一层没有了唯一的来源（`SessionState.grants` 只能由
 * `permission.decision` 事件产生），于是整组代码一起删除，`session` 层本身也随之消失。
 *
 * 顺带记下那几条曾经付过学费的细节，将来若要重新引入"事中授权"，同样的坑还在原地：
 *
 *   〇 先规范化再转义，否则 Windows 上授权存 `C:\work\a.md`、判定比 `C:/work/a.md`，
 *     "本会话都允许"点了等于没点（三平台 CI 实测，M1-c 补记）；
 *   一 授权的 target 是**字面量**不是模式，`a*b` / `log?.txt` 都是合法文件名，
 *     不转义会让一次针对单个文件的授权放行一批文件——而授权是会被持久化的；
 *   二 `deny` 的授权也要合成，只合成 allow 等于回放出的会话比当时更松；
 *   三 规范化失败的授权直接丢弃（**失败关闭**），不要留一条建立在判不了的 target
 *     上的规则。
 *
 * 新模型里"我允许这个目标"的表达方式是人手写进 `config.json` 的一条持久规则，
 * 它走的是用户层，不需要合成，也不需要转义（人写的本来就是模式）。
 */
