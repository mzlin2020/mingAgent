import type { AbortLike } from '../tool/types.js';

export type ServiceKey<S extends object> = Extract<keyof S, string>;

export type EffectDisposer = () => unknown;
export type EffectSetup = () => unknown;

export type EventMode = 'emit' | 'parallel' | 'serial' | 'waterfall';

interface EventPoint<M extends EventMode, A extends unknown[], R> {
  readonly name: string;
  readonly mode: M;
  /** 只承载类型参数，不在运行时读取。 */
  readonly _args?: A;
  /** 只承载类型参数，不在运行时读取。 */
  readonly _result?: R;
}

export type EmitEvent<A extends unknown[]> = EventPoint<'emit', A, void>;
export type ParallelEvent<A extends unknown[]> = EventPoint<'parallel', A, void>;
export type SerialEvent<A extends unknown[], R> = EventPoint<'serial', A, R>;
export type WaterfallEvent<A extends unknown[], R> = EventPoint<'waterfall', A, R>;
export type AnyEventPoint = EventPoint<EventMode, unknown[], unknown>;

export type EmitListener<A extends unknown[]> = (...args: A) => void;
export type ParallelListener<A extends unknown[]> = (
  signal: AbortLike,
  ...args: A
) => unknown;
export type SerialListener<A extends unknown[], R> = (
  signal: AbortLike,
  ...args: A
) => R | false | null | undefined | Promise<R | false | null | undefined>;
/**
 * 环绕中间件手里的 `next`。
 *
 * 可选参数 `narrower` 是 ADR-0055 硬约束 3 允许的那一件事：为这一次调用套一个**更短**的
 * 截止时间。派发方把它与当前生效的 signal 取并集后交给后续监听器与最内层核心，
 * 因此它只能收紧——延长或摘掉在结构上做不到。
 */
export type WaterfallNext<R> = (narrower?: AbortLike) => Promise<R>;
/** 最内层核心：由派发方提供，收到的是这条链上已经收紧过的 signal。 */
export type WaterfallCore<R> = (signal: AbortLike) => R | Promise<R>;
export type WaterfallListener<A extends unknown[], R> = (
  signal: AbortLike,
  ...args: [...A, WaterfallNext<R>]
) => R | Promise<R>;

export interface ContainerPlugin<S extends object> {
  readonly name: string;
  readonly inject?: readonly ServiceKey<S>[];
  readonly provide?: readonly ServiceKey<S>[];
  apply(ctx: ContainerContext<S>): unknown;
}

export type PluginState = 'pending' | 'active' | 'disposed';

export interface PluginHandle {
  readonly name: string;
  readonly state: PluginState;
  dispose(): Promise<void>;
}

export interface ContainerContextApi<S extends object> {
  readonly active: boolean;
  has(key: ServiceKey<S>): boolean;
  get<K extends ServiceKey<S>>(key: K): S[K];
  provide<K extends ServiceKey<S>>(key: K, value: S[K]): EffectDisposer;
  effect(setup: EffectSetup): EffectDisposer;
  fork(): ContainerContext<S>;
  dispose(): Promise<void>;

  on<A extends unknown[]>(event: EmitEvent<A>, listener: EmitListener<A>): EffectDisposer;
  on<A extends unknown[]>(
    event: ParallelEvent<A>,
    listener: ParallelListener<A>,
  ): EffectDisposer;
  on<A extends unknown[], R>(
    event: SerialEvent<A, R>,
    listener: SerialListener<A, R>,
  ): EffectDisposer;
  on<A extends unknown[], R>(
    event: WaterfallEvent<A, R>,
    listener: WaterfallListener<A, R>,
  ): EffectDisposer;

  emit<A extends unknown[]>(event: EmitEvent<A>, ...args: A): void;
  parallel<A extends unknown[]>(
    event: ParallelEvent<A>,
    signal: AbortLike,
    ...args: A
  ): Promise<void>;
  serial<A extends unknown[], R>(
    event: SerialEvent<A, R>,
    signal: AbortLike,
    ...args: A
  ): Promise<R | undefined>;
  waterfall<A extends unknown[], R>(
    event: WaterfallEvent<A, R>,
    signal: AbortLike,
    ...args: [...A, WaterfallCore<R>]
  ): Promise<R>;
}

/** Proxy 在运行时把服务 key 映射成稳定的 `ctx.<key>` 属性。 */
export type ContainerContext<S extends object> = Readonly<S> & ContainerContextApi<S>;

export interface WaitingPlugin {
  readonly plugin: string;
  readonly services: readonly string[];
}
