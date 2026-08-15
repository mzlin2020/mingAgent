import type { ReactNode } from 'react';
import type { ToolCard, ToolCardKind } from '@xm/contracts';

/**
 * 渲染器注册表（ADR-0058 §五）。
 *
 * **渲染层认识的是卡片种类，不是工具。** 加一个工具不需要动这里任何一行；
 * 插件能贡献的是这四种种类的渲染器，不能贡献第五种种类——种类若随工具数量增长，
 * 就等于换个地方重演"每加一个工具改一处 UI"。
 *
 * 注册表是纯数据：渲染器拿到的是**已经过 Zod 校验的卡片**，没有 Node 权限、
 * 没有 IPC 句柄。它能做的唯一一件"往外说话"的事是调 `onAction(actionId, payload)`，
 * 而那条路上渲染层连工具名都看不见（ADR-0065）。
 */

export type CardActionInvoke = (actionId: string, payload: Record<string, unknown>) => void;

export interface CardRendererProps {
  readonly card: ToolCard;
  /** 已完成的调用为 false；挂起态卡片为 true */
  readonly pending: boolean;
  readonly failed: boolean;
  /** 动作正在路上时禁用按钮；主进程侧照样会拒绝重复动作，这里只是不让人白点 */
  readonly busy: boolean;
  readonly onAction: CardActionInvoke;
}

export type CardRenderer = (props: CardRendererProps) => ReactNode;

const renderers = new Map<ToolCardKind, CardRenderer>();

/** 注册一种卡片的渲染器。返回撤销函数——与容器的 `ctx.effect()` 同形，卸载即消失 */
export function registerRenderer(kind: ToolCardKind, renderer: CardRenderer): () => void {
  renderers.set(kind, renderer);
  return () => {
    if (renderers.get(kind) === renderer) renderers.delete(kind);
  };
}

/**
 * 找不到渲染器时返回 `undefined`，由调用方降级为一行摘要。
 *
 * **绝不白屏**：三方插件贡献的卡片种类在我们这里没有渲染器，是发布前测不到的组合，
 * 而 `DisplayHint.summary` 那条降级要求原样继承到了 `ToolCard.summary` 上。
 */
export const rendererFor = (kind: ToolCardKind): CardRenderer | undefined => renderers.get(kind);

/** 只给测试用：清空注册表，构造"没有任何渲染器"的场景 */
export const resetRenderers = (): void => {
  renderers.clear();
};
