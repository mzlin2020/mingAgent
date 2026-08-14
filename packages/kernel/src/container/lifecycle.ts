import { ContainerInactiveError } from './errors.js';
import type { EffectDisposer, EffectSetup } from './types.js';

/** 最小效果所有者：同步建立，反向、幂等、可等待地撤销。 */
export class EffectOwner {
  readonly label: string;
  #active = true;
  #effects: EffectDisposer[] = [];

  constructor(label: string) {
    this.label = label;
  }

  get active(): boolean {
    return this.#active;
  }

  assertActive(): void {
    if (!this.#active) throw new ContainerInactiveError(this.label);
  }

  effect(setup: EffectSetup): EffectDisposer {
    this.assertActive();
    const cleanup = setup();
    if (cleanup !== undefined && typeof cleanup !== 'function') {
      throw new TypeError(`${this.label} 的效果必须返回撤销函数或 undefined。`);
    }
    return this.adopt((cleanup as EffectDisposer | undefined) ?? (() => undefined));
  }

  adopt(cleanup: EffectDisposer): EffectDisposer {
    this.assertActive();
    let active = true;
    const wrapped = async (): Promise<void> => {
      if (!active) return;
      active = false;
      const index = this.#effects.indexOf(wrapped);
      if (index >= 0) this.#effects.splice(index, 1);
      await cleanup();
    };
    this.#effects.push(wrapped);
    return wrapped;
  }

  async dispose(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    const errors: unknown[] = [];
    for (const cleanup of this.#effects.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${this.label} 卸载时有 ${String(errors.length)} 个效果失败。`);
    }
  }
}
