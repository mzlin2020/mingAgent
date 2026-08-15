import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：Provider 适配器是无状态的（每轮现造，见 desktop-host 的注释），
 * 它把 SSE 流翻译成 `ModelChunk`，不写事件、不持有会话状态。
 *
 * `provider.status` 是瞬态事件，且由 runtime 记录；"重试次数不超过上限"这类关系
 * 属于适配器内部，用单元测试打得更准，也不需要一个真实会话才检验得到。
 */
export const providersInvariants: InvariantInstaller = () => undefined;
