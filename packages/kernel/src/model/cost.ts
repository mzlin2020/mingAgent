import type { ModelPrice, PriceTable, Usage } from '@xm/contracts';
import { priceKey } from '@xm/contracts';

/**
 * 成本核算。纯函数，放内核。
 *
 * `usage.ts` 定的分工：Provider 只报 token 数，成本由这里查价格表算出。
 * 那条分工的实际收益是——**换价格不用发版，也不用碰任何适配器**。
 */

const PER_MILLION = 1_000_000;

/**
 * 算不出来时返回 `undefined`，**不返回 0**。
 *
 * 这是本文件唯一重要的决定。返回 0 会让"这次没花钱"和"我们不知道花了多少"
 * 变成同一个值，而 UI 只能显示前者：用户看到一个精确到分的 $0.00，
 * 没有任何线索知道它是编的。
 *
 * 同一条纪律在 PolicyEngine 里的形态是「判不了就 deny，不要 ask」。
 * 这里判不了不涉及安全，所以不必拒绝，但同样不许假装知道。
 */
export function costOf(usage: Usage, price: ModelPrice | undefined): number | undefined {
  if (price === undefined) return undefined;

  // 缓存价缺省时按 input 计：这是"不知道折扣"时唯一不会低估的取法
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;

  const total =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite;

  return total / PER_MILLION;
}

export const lookupPrice = (
  prices: PriceTable | undefined,
  provider: string,
  model: string,
): ModelPrice | undefined => prices?.[priceKey(provider, model)];
