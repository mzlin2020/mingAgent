import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：`@xm/storage` 拥有的关系（append 的原子性、单写者标记、
 * seq 冲突即抛）全部是**调用期**关系，在事件流上看不见——一次被拒绝的并发写
 * 根本不会留下事件。
 *
 * 这些关系已经由 `EVENT_STORE_CONTRACT` 逐条打过，而那套用例是跨实现的：
 * 内存实现与 SQLite 实现跑同一份。把它们搬进运行时不变量不会多测到任何东西。
 *
 * 重新审视的条件：如果存储层开始产出自己的事件（例如"快照写失败"从
 * `notice.posted` 改成一条存储自己的事件），那条流就归它，不变量也跟着归它。
 */
export const storageInvariants: InvariantInstaller = () => undefined;
