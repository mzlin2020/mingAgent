import type { Capability } from '@xm/contracts';
import { PERSISTED_EVENT_TYPES } from '@xm/contracts';
import type { InvariantInstaller } from './introspect/invariant.js';

/**
 * `@xm/kernel` 的运行时不变量（ADR-0060）。
 *
 * 这个包拥有 seq 的分配规则、归约的语义与判定的语义，所以这三条关系归它断言。
 * 回合的配对归 `@xm/runtime`——**跨包的关系归属给拥有那条事件流的包**，
 * 断言一个自己控制不了的东西，误报只是时间问题，而一次误报会让人把整个机制关掉。
 */

/**
 * 不可信上下文下被**红线**挡住的三个能力（`policy/defaults.ts` 的
 * `red.secrets-read-untrusted` / `red.gui-input-untrusted` / `red.plugin-install-untrusted`）。
 *
 * 只取 immutable 的那三条，不含 `UNTRUSTED_CONTEXT_RULES` 那三条：后者用户可以在
 * `config.json` 里写 allow 放开，出现在事件流里是**合法**的。拿可覆盖的规则做不变量，
 * 第一个合法放开的用户就会撞上一次误报。
 */
const RED_UNDER_UNTRUSTED: readonly Capability[] = ['secrets.read', 'gui.input', 'plugin.install'];

export const kernelInvariants: InvariantInstaller = (api) => {
  /*
   * ── 立身之本的那一条（ADR-0060 反向演练 3）──
   *
   * `trustLevel` 曾经在整个代码库里只被硬编码成 `'model'`，于是六条
   * `match: { trustLevel: ['untrusted'] }` 的规则一次也没触发过：判定逻辑是对的、
   * 测试是绿的、防御是不存在的。那次事故活了整整一个里程碑。
   *
   * 它在事件流上的形态非常具体：**会话已经污染了，却仍有一次带红线能力的调用开始执行**。
   * 被拒的调用连 `tool.start` 都不会产生（闸门在执行之前），所以这条事件出现本身
   * 就是"红线没拦住"的证据——不需要去读判定的中间结果，也就不会被中间结果的写法骗过。
   */
  api.on(['tool.start'], '不可信上下文下红线能力不得开始执行', ({ event, before }) => {
    if (before.untrustedContext === undefined) return undefined;
    const hit = event.payload.capabilities.filter((c) => RED_UNDER_UNTRUSTED.includes(c));
    if (hit.length === 0) return undefined;
    return (
      `会话已处于不可信上下文（来自 ${before.untrustedContext.toolName} 的 ` +
      `${before.untrustedContext.viaCapability}），工具 ${event.payload.name} 却带着 ` +
      `${hit.join('、')} 开始执行。这三个能力在不可信上下文下由不可覆盖的红线拒绝——` +
      `它能跑起来，说明判定路径没把不可信标记算进去。`
    );
  });

  /*
   * seq 严格递增、无空洞。
   *
   * "无空洞"不是洁癖：`docs/10 §4.1` 的"从 seq N 起增量订阅"完全建立在它上面，
   * 有洞就得靠额外元数据才知道自己是不是漏了一条。存储层的主键只拦得住**重复**，
   * 拦不住跳号——跳号发生在分配那一侧，只有在事件流上才看得见。
   */
  api.on(PERSISTED_EVENT_TYPES, 'seq 严格递增且无空洞', ({ event, before }) =>
    event.seq === before.lastSeq + 1
      ? undefined
      : `持久事件的 seq 应当是 ${String(before.lastSeq + 1)}，实际是 ${String(event.seq)}。`,
  );

  /*
   * `tool.start` 与 `tool.end` 的 callId 一一对应。
   *
   * 判据取自 `runningCalls`（归约出来的），不是自己攒一份内存表——攒一份就等于
   * 在断言"我这份表和 reduce 那份表一致"，而那是同义反复。
   */
  api.on(['tool.start'], 'tool.start 的 callId 不重复', ({ event, before }) =>
    before.runningCalls.has(event.payload.callId)
      ? `callId ${event.payload.callId} 已经在跑了，同一次调用不能开始两次。`
      : undefined,
  );

  /*
   * ⚠️ 这条不是 ADR-0060 原文写的"`tool.start` 与 `tool.end` 的 callId **一一对应**"。
   *
   * 那句话在这个系统里是**错的**：被闸门拒掉的调用只记 `tool.end`（`failCall`），
   * 连 `tool.start` 都不产生——这正是"闸门在执行之前"的可观察形态（ADR-0065 §四）。
   * 照原文写，第一次真实拒绝就会误报，而误报比漏报更伤：一次误报就会让人把整个机制关掉。
   *
   * 真正成立、且真正值得断言的是**单向**的那一半：一次**成功**的结束必有开始。
   * 它拦的是"有东西没走完整十二步链就产出了结果"。
   */
  api.on(['tool.end'], '成功的 tool.end 必有配对的 tool.start', ({ event, before }) => {
    if (!event.payload.ok) return undefined;
    return before.runningCalls.has(event.payload.callId)
      ? undefined
      : `callId ${event.payload.callId} 没有开始过却成功结束了——` +
          `有东西绕开工具执行链产出了结果。`;
  });
};
