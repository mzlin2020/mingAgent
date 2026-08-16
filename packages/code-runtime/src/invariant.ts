import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：本包**不写事件**。
 *
 * 不变量注册表（ADR-0060）断言的是事件流上的关系，而本包在事件流上一条记录也没有——
 * 它跑一段程序、把绑定调用交回宿主，落库的事情全部发生在 `@xm/runtime` 那一侧
 * （`tool.code.dispatch` 由子调用派发器写，那条不变量属于 runtime 包）。
 *
 * 本包真正的验收断言在别处，而且都是"某某拿不到"这种形状：客体域的全局面被逐名钉死、
 * 四条穿透探针、朴素 worker 的反向演练。它们是**加载期与执行期**的事实，
 * 不是事件流上的关系——按 `check:invariants` 的第 4 条判据，把它们写成不变量
 * 只会得到一条永远绿的断言。见 `packages/code-runtime/tests/isolation.test.ts`。
 *
 * 重新审视的条件：本包若开始自己往事件流里写东西（例如把每次预算耗尽落一条事件），
 * 这里必须补上"预算耗尽必有终局事件"这类断言。
 */
export const codeRuntimeInvariants: InvariantInstaller = () => undefined;
