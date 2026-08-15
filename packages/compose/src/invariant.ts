import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：`@xm/compose` 只在**装配期**工作——解析 profile、合并 patch、
 * 断言基线层在位、把插件行交给容器。装配一结束它就不再参与任何事。
 *
 * 它最该被盯住的"基线行不可被 patch 替换、删除或重排"是**装配期**断言，
 * 已经落在 `assemble.ts` 的 `assertBaseline()` 里，缺了当场拒绝启动——
 * 比事后在事件流上发现要早得多，也不需要一个真实会话。
 */
export const composeInvariants: InvariantInstaller = () => undefined;
