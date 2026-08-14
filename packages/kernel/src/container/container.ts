import type { AbortLike } from '../tool/types.js';
import {
  ContainerDependencyError,
  MissingServiceError,
  PluginProvideError,
  ServiceConflictError,
} from './errors.js';
import { ContainerEvents } from './events.js';
import { EffectOwner } from './lifecycle.js';
import type {
  AnyEventPoint,
  ContainerContext,
  ContainerPlugin,
  EffectDisposer,
  EffectSetup,
  PluginHandle,
  PluginState,
  ServiceKey,
  WaitingPlugin,
  WaterfallNext,
} from './types.js';

interface ServiceEntry {
  readonly value: unknown;
  readonly owner: EffectOwner;
}

class ServiceScope extends EffectOwner {
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

interface ContainerRuntime {
  readonly events: ContainerEvents;
  createScope(root?: ServiceScope): ServiceScope;
}

const CONTEXT_METHODS = new Set([
  'active',
  'has',
  'get',
  'provide',
  'effect',
  'fork',
  'dispose',
  'on',
  'emit',
  'parallel',
  'serial',
  'waterfall',
  'then',
]);

class ContextController<S extends object> {
  readonly runtime: ContainerRuntime;
  readonly scope: ServiceScope;
  readonly owner: EffectOwner;
  readonly pluginName: string | undefined;
  readonly allowedProvides: ReadonlySet<string> | undefined;
  readonly disposeContext: () => Promise<void>;

  constructor(
    runtime: ContainerRuntime,
    scope: ServiceScope,
    owner: EffectOwner,
    pluginName?: string,
    allowedProvides?: ReadonlySet<string>,
    disposeContext: () => Promise<void> = () => owner.dispose(),
  ) {
    this.runtime = runtime;
    this.scope = scope;
    this.owner = owner;
    this.pluginName = pluginName;
    this.allowedProvides = allowedProvides;
    this.disposeContext = disposeContext;
  }

  proxy(): ContainerContext<S> {
    const api: Record<string, unknown> = {
      has: (key: string) => this.scope.resolve(key) !== undefined,
      get: (key: string) => this.#service(key),
      provide: (key: string, value: unknown) => this.#provide(key, value),
      effect: (setup: EffectSetup) => this.owner.effect(setup),
      fork: () => this.#fork(),
      dispose: () => this.disposeContext(),
      on: (event: AnyEventPoint, listener: (...args: unknown[]) => unknown) =>
        this.owner.effect(() => this.runtime.events.register(this.scope, event, listener)),
      emit: (event: AnyEventPoint, ...args: unknown[]) => {
        this.runtime.events.emit(this.scope, event, args);
      },
      parallel: (event: AnyEventPoint, signal: AbortLike, ...args: unknown[]) =>
        this.runtime.events.parallel(this.scope, event, signal, args),
      serial: (event: AnyEventPoint, signal: AbortLike, ...args: unknown[]) =>
        this.runtime.events.serial(this.scope, event, signal, args),
      waterfall: (event: AnyEventPoint, signal: AbortLike, ...args: unknown[]) => {
        const inner = args.pop() as WaterfallNext<unknown> | undefined;
        if (inner === undefined || typeof inner !== 'function') {
          throw new TypeError(`waterfall "${event.name}" 缺少最终 next。`);
        }
        return this.runtime.events.waterfall(this.scope, event, signal, args, inner);
      },
    };
    const target = Object.create(null) as Record<string | symbol, unknown>;
    return new Proxy(target, {
      get: (_target, property) => {
        if (property === Symbol.toStringTag) return 'ContainerContext';
        if (property === 'active') return this.scope.active && this.owner.active;
        if (typeof property !== 'string') return undefined;
        if (Object.hasOwn(api, property)) return api[property];
        if (property === 'then' && this.scope.resolve(property) === undefined) return undefined;
        return this.#service(property);
      },
      has: (_target, property) =>
        typeof property === 'string' &&
        (property === 'active' || Object.hasOwn(api, property) || this.scope.resolve(property) !== undefined),
    }) as ContainerContext<S>;
  }

  #service(key: string): unknown {
    this.scope.assertActive();
    const entry = this.scope.resolve(key);
    if (entry === undefined) throw new MissingServiceError(key);
    return entry.value;
  }

  #provide(key: string, value: unknown): EffectDisposer {
    this.owner.assertActive();
    if (CONTEXT_METHODS.has(key)) {
      throw new ServiceConflictError(key, '与容器上下文方法重名');
    }
    if (this.allowedProvides !== undefined && !this.allowedProvides.has(key)) {
      throw new PluginProvideError(this.pluginName ?? 'unknown', key, '没有在 provide 中声明');
    }
    return this.owner.effect(() => this.scope.register(key, value, this.owner));
  }

  #fork(): ContainerContext<S> {
    this.owner.assertActive();
    const child = this.runtime.createScope(this.scope.rootScope);
    this.owner.adopt(() => child.dispose());
    return new ContextController<S>(
      this.runtime,
      child,
      child,
      undefined,
      undefined,
      () => child.dispose(),
    ).proxy();
  }
}

class PluginHandleImpl<S extends object> implements PluginHandle {
  readonly plugin: ContainerPlugin<S>;
  readonly scope: ServiceScope;
  #state: PluginState = 'pending';
  #owner?: EffectOwner;

  constructor(plugin: ContainerPlugin<S>, scope: ServiceScope) {
    this.plugin = plugin;
    this.scope = scope;
  }

  get name(): string {
    return this.plugin.name;
  }

  get state(): PluginState {
    return this.#state;
  }

  setOwner(owner: EffectOwner): void {
    this.#owner = owner;
  }

  markActive(): void {
    this.#state = 'active';
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    await this.#owner?.dispose();
  }
}

export class PluginContainer<S extends object = Record<never, never>> {
  readonly #runtime: ContainerRuntime;
  readonly #root: ServiceScope;
  readonly #handles: PluginHandleImpl<S>[] = [];
  readonly context: ContainerContext<S>;

  constructor() {
    let scopeCounter = 0;
    this.#runtime = {
      events: new ContainerEvents(),
      createScope: (root?: ServiceScope) => new ServiceScope(scopeCounter++, root),
    };
    this.#root = this.#runtime.createScope();
    this.context = new ContextController<S>(
      this.#runtime,
      this.#root,
      this.#root,
      undefined,
      undefined,
      () => this.dispose(),
    ).proxy();
  }

  provide<K extends ServiceKey<S>>(key: K, value: S[K]): EffectDisposer {
    return this.context.provide(key, value);
  }

  use(plugin: ContainerPlugin<S>): PluginHandle {
    this.#root.assertActive();
    if (plugin.name.length === 0) throw new TypeError('插件名不能为空。');
    if (this.#handles.some((handle) => handle.state !== 'disposed' && handle.name === plugin.name)) {
      throw new TypeError(`插件名冲突："${plugin.name}"。`);
    }
    const handle = new PluginHandleImpl(plugin, this.#root);
    this.#handles.push(handle);
    return handle;
  }

  async start(): Promise<void> {
    this.#root.assertActive();
    const pending = this.#handles.filter((handle) => handle.state === 'pending');
    this.#assertAdvertisedConflicts(pending);
    const activated: PluginHandleImpl<S>[] = [];
    try {
      while (pending.length > 0) {
        const readyIndex = pending.findIndex((handle) => this.#missing(handle).length === 0);
        if (readyIndex < 0) throw this.#dependencyError(pending);
        const [handle] = pending.splice(readyIndex, 1);
        if (handle === undefined) throw new Error('容器内部错误：readyIndex 丢失。');
        await this.#activate(handle);
        activated.push(handle);
      }
    } catch (error) {
      for (const handle of activated.reverse()) await handle.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const handle of [...this.#handles].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#root.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, '容器卸载失败。');
  }

  async #activate(handle: PluginHandleImpl<S>): Promise<void> {
    const owner = new EffectOwner(`插件 "${handle.name}"`);
    handle.setOwner(owner);
    const provide = new Set<string>(handle.plugin.provide ?? []);
    const ctx = new ContextController<S>(
      this.#runtime,
      handle.scope,
      owner,
      handle.name,
      provide,
      () => handle.dispose(),
    ).proxy();
    try {
      const cleanup = await handle.plugin.apply(ctx);
      if (cleanup !== undefined) {
        if (typeof cleanup !== 'function') {
          throw new TypeError(`插件 "${handle.name}" 的 apply() 必须返回撤销函数或 undefined。`);
        }
        owner.adopt(cleanup as EffectDisposer);
      }
      for (const key of provide) {
        if (handle.scope.own(key)?.owner !== owner) {
          throw new PluginProvideError(handle.name, key, '已声明但 apply() 完成后没有真实注册');
        }
      }
      handle.markActive();
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  #missing(handle: PluginHandleImpl<S>): string[] {
    return (handle.plugin.inject ?? []).filter((key) => handle.scope.resolve(key) === undefined);
  }

  #assertAdvertisedConflicts(handles: readonly PluginHandleImpl<S>[]): void {
    const providers = new Map<string, string>();
    for (const handle of handles) {
      for (const key of handle.plugin.provide ?? []) {
        const name = key;
        const previous = providers.get(name);
        if (previous !== undefined) {
          throw new ServiceConflictError(name, `插件 "${previous}" 与 "${handle.name}" 都声明提供`);
        }
        providers.set(name, handle.name);
      }
    }
  }

  #dependencyError(pending: readonly PluginHandleImpl<S>[]): ContainerDependencyError {
    const waiting: WaitingPlugin[] = pending.map((handle) => ({
      plugin: handle.name,
      services: this.#missing(handle),
    }));
    for (const item of waiting) {
      for (const service of item.services) {
        const hasProvider = pending.some((handle) =>
          (handle.plugin.provide ?? []).includes(service as ServiceKey<S>),
        );
        if (!hasProvider) {
          return new ContainerDependencyError(
            waiting,
            `插件 ${item.plugin} 等待服务 ${service}（无提供者）。`,
          );
        }
      }
    }
    const chain = this.#findCycle(pending) ?? [];
    return new ContainerDependencyError(
      waiting,
      `检测到依赖环：${chain.join(' -> ')}。`,
      chain,
    );
  }

  #findCycle(pending: readonly PluginHandleImpl<S>[]): string[] | undefined {
    const walk = (
      handle: PluginHandleImpl<S>,
      stack: readonly PluginHandleImpl<S>[],
      chain: readonly string[],
    ): string[] | undefined => {
      for (const service of this.#missing(handle)) {
        const provider = pending.find((candidate) =>
          (candidate.plugin.provide ?? []).includes(service as ServiceKey<S>),
        );
        if (provider === undefined) continue;
        const nextChain = [...chain, service, provider.name];
        if (stack.includes(provider)) return nextChain;
        const nested = walk(provider, [...stack, provider], nextChain);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    for (const handle of pending) {
      const found = walk(handle, [handle], [handle.name]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}
