import { ServiceConflictError } from './errors.js';
import { EffectOwner } from './lifecycle.js';
import type { EffectDisposer } from './types.js';

/**
 * 服务作用域：一层"谁提供了什么"的表，外加它自己的效果生命周期。
 *
 * `fork()` 出来的子作用域按**两级扁平**解析（ADR-0067）：先看自己，再看根，
 * 没有第三层——子 Agent 的作用域不会再套一层，链式解析在调试时是个黑洞。
 */
export interface ServiceEntry {
  readonly value: unknown;
  readonly owner: EffectOwner;
}

export class ServiceScope extends EffectOwner {
  readonly id: number;
  readonly rootId: number;
  readonly rootScope: ServiceScope;
  readonly #services = new Map<string, ServiceEntry>();

  constructor(id: number, root?: ServiceScope) {
    super(root === undefined ? '根作用域' : `fork 作用域 #${String(id)}`);
    this.id = id;
    this.rootScope = root ?? this;
    this.rootId = this.rootScope.id;
  }

  resolve(key: string): ServiceEntry | undefined {
    return this.#services.get(key) ??
      (this === this.rootScope ? undefined : this.rootScope.#services.get(key));
  }

  own(key: string): ServiceEntry | undefined {
    return this.#services.get(key);
  }

  register(key: string, value: unknown, owner: EffectOwner): EffectDisposer {
    this.assertActive();
    if (this.#services.has(key)) {
      throw new ServiceConflictError(key, `${this.label} 已有提供者`);
    }
    const entry = { value, owner };
    this.#services.set(key, entry);
    return () => {
      if (this.#services.get(key) === entry) this.#services.delete(key);
    };
  }
}
