import { InvariantRegistry, kernelInvariants } from '@xm/kernel';
import { runtimeInvariants } from './invariant.js';

/**
 * 装配期把各包的伴生模块接上（ADR-0060）。
 *
 * ── 为什么只有两个包在这张表上 ──
 *
 * 其余七个包的伴生模块都是**空 installer 加一句理由**（纯 schema 包、薄适配器、
 * 只在装配期工作的组合包）。空 installer 注册与不注册在运行时完全等价，
 * 所以这张表只列真正有断言的包。`scripts/check-invariants.mjs` 盯着这件事：
 * 哪个包的伴生模块从空变成非空，而这里没跟着加，闸门就红。
 *
 * ── 为什么这张表在 `@xm/runtime` 而不是 `@xm/compose` ──
 *
 * compose 只依赖 contracts 与 kernel（depcruise 规则「只有 apps 可以依赖 compose」的
 * 另一面），接不到 runtime。而 runtime 依赖 kernel，两个有断言的包正好都够得着。
 * 如果哪天 `@xm/storage` 长出真的不变量，它接不进这张表——那时要给它单开一行 profile 行，
 * 而不是把 runtime 的依赖面撑开。
 */
export const createInvariantRegistry = (): {
  readonly registry: InvariantRegistry;
  readonly dispose: () => void;
} => {
  const registry = new InvariantRegistry();
  const offs = [
    registry.register('@xm/kernel', kernelInvariants),
    registry.register('@xm/runtime', runtimeInvariants),
  ];
  return {
    registry,
    dispose: () => {
      for (const off of offs.reverse()) off();
    },
  };
};
