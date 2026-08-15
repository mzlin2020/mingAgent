import { describe, expect, it } from 'vitest';
import { ToolCard } from '@xm/contracts';
import { registerRenderer, rendererFor, resetRenderers } from '../src/renderer/lib/card-registry.js';

/**
 * 渲染器注册表（ADR-0058 §五）与"绝不白屏"的降级。
 *
 * 这里不碰组件（`cards.tsx` 属于渲染层工程，与测试工程的 lib/types 不同）。
 * 降级这件事的成立条件是两条纯数据性质：
 *  ① 注册表按 `card.kind` 查，查不到就返回 undefined（这是降级的触发条件）
 *  ② 任何一张合法卡片都有非空 `summary`（没有渲染器时它是唯一被画出来的东西）
 *
 * "四种内建卡片都有渲染器"这条**不靠测试守**：`cards.tsx` 里那张表的类型是
 * `Record<ToolCardKind, CardRenderer>`，少一种当场编译失败——比一条会被忘记更新的用例强。
 */

const KINDS = ['generic', 'terminal', 'diff', 'search'] as const;

const stub = (): null => null;

describe('M3-f 卡片渲染器注册表', () => {
  it('注册后按 kind 查得到，撤销后立刻查不到（与容器的 effect 同形）', () => {
    resetRenderers();
    const dispose = registerRenderer('diff', stub);
    expect(rendererFor('diff')).toBe(stub);
    dispose();
    expect(rendererFor('diff')).toBeUndefined();
  });

  it('🔴 没有对应渲染器时 rendererFor 返回 undefined —— 这是降级为摘要的触发条件', () => {
    resetRenderers();
    for (const kind of KINDS) expect(rendererFor(kind)).toBeUndefined();
  });

  it('🔴 空摘要的卡片过不了契约校验：降级路径不会退化成一片空白', () => {
    const blank = ToolCard.safeParse({ kind: 'generic', title: 'x', summary: '' });
    expect(blank.success).toBe(false);
    const ok = ToolCard.safeParse({ kind: 'search', summary: '找到 3 处', truncated: false });
    expect(ok.success).toBe(true);
  });

  it('注册表的键是卡片种类，不是工具名——加一个工具不会让这里多一项', () => {
    resetRenderers();
    for (const kind of KINDS) registerRenderer(kind, stub);
    expect(rendererFor('flamegraph' as (typeof KINDS)[number])).toBeUndefined();
  });
});
