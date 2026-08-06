import { z } from 'zod';

/**
 * 价格表。**是配置，不是代码。**
 *
 * `usage.ts` 已经写死了这条分工：「价格会变、会有折扣、不同账户不同价——
 * 硬编码进适配器就等于每次调价都要改代码发版」。
 *
 * ── 为什么仓库里不带一份"默认价格" ──
 *
 * 带一份就等于**发布一个会过期的事实**。价格改了而仓库没跟上时，
 * UI 上照样显示一个精确到分的数字，用户没有任何线索知道它是错的——
 * 一个自信的错数字比一个诚实的空值糟糕得多。
 *
 * 所以默认是空表，算不出成本时 `costOf()` 返回 `undefined`，UI 显示"未配置价格"。
 * 这与内核里到处在用的失败关闭是同一条：**判不了就说判不了，不要猜。**
 */

/** 单位：美元 / 每百万 token。用百万是因为各家公布价格时都用这个单位，抄错的概率最低 */
export const ModelPrice = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** 缓存命中读取，通常有折扣。缺省时按 input 计 */
  cacheRead: z.number().nonnegative().optional(),
  /** 写入缓存，通常有溢价。缺省时按 input 计 */
  cacheWrite: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * 键是 `"<provider>/<model>"`，与 `Config.model.main` 的写法一致。
 *
 * 不用裸 model 名：同一个模型 id 在官方端点与兼容端点上价格可以完全不同，
 * 而「兼容端点」正是这个项目从第一天就支持的东西。
 */
export const PriceTable = z.record(z.string(), ModelPrice);
export type PriceTable = z.infer<typeof PriceTable>;

export const priceKey = (provider: string, model: string): string => `${provider}/${model}`;
