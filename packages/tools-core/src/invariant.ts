import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：业务工具的正确性是"给定入参产出什么结果"，那是单元测试的职责。
 * 工具**执行链**上的关系（调用必有开始、成功必先开始）归 `@xm/kernel`——它拥有
 * 那条判定与归约的流；工具自己断言一遍只会变成两份可能不一致的说法。
 *
 * 重新审视的条件：某个工具如果开始写自己的 `ext.*` 事件（ADR-0057），
 * 那条流就归它，届时它的投影关系应当在这里断言。
 */
export const toolsCoreInvariants: InvariantInstaller = () => undefined;
