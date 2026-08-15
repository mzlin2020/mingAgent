import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：`@xm/platform` 是 `PlatformPort` 的薄适配器（os 识别、路径、
 * 能力探测、配置加载、密钥后端），它不产生事件、也不持有跨调用的可变关系。
 *
 * 它最该被盯住的那件事——"平台判断一律走 `PlatformPort.os`"（ADR-0007）——是一条
 * **静态**约束，由 depcruise 与代码审查拦，运行时无从观察。
 *
 * 重新审视的条件：密钥后端降级如果开始记事件（今天走 `notice.posted`，由 runtime 记），
 * 那条降级路径就该在这里长出一条不变量。
 */
export const platformInvariants: InvariantInstaller = () => undefined;
