import type { AbortLike } from '../tool/types.js';
import { DispatchAbortedError, EventDefinitionError } from './errors.js';
import type {
  AnyEventPoint,
  EmitEvent,
  EventMode,
  ParallelEvent,
  SerialEvent,
  WaterfallEvent,
  WaterfallNext,
} from './types.js';

type UnknownListener = (...args: unknown[]) => unknown;

interface EventScope {
  readonly id: number;
  readonly rootId: number;
}

interface ListenerRecord {
  readonly scopeId: number;
  readonly callback: UnknownListener;
}

const point = <M extends EventMode>(name: string, mode: M): { readonly name: string; readonly mode: M } => {
  if (name.length === 0) throw new TypeError('容器事件名不能为空。');
  return Object.freeze({ name, mode });
};

export const defineEmitEvent = <A extends unknown[]>(name: string): EmitEvent<A> =>
  point(name, 'emit');

export const defineParallelEvent = <A extends unknown[]>(name: string): ParallelEvent<A> =>
  point(name, 'parallel');

export const defineSerialEvent = <A extends unknown[], R>(name: string): SerialEvent<A, R> =>
  point(name, 'serial');

export const defineWaterfallEvent = <A extends unknown[], R>(
  name: string,
): WaterfallEvent<A, R> => point(name, 'waterfall');

const isBailed = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false;

const abortable = async <T>(
  eventName: string,
  signal: AbortLike,
  operation: () => T | Promise<T>,
): Promise<T> => {
  if (signal.aborted) throw new DispatchAbortedError(eventName);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new DispatchAbortedError(eventName));
      });
    };
    signal.addEventListener('abort', onAbort);
    try {
      Promise.resolve(operation()).then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            // 错误原样上抛是 ADR-0062 的显式契约，不能为了 lint 把非 Error 值偷偷包装。
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(error);
          });
        },
      );
    } catch (error) {
      finish(() => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      });
    }
  });
};

export class ContainerEvents {
  readonly #modes = new Map<string, EventMode>();
  readonly #listeners = new Map<string, ListenerRecord[]>();

  register(scope: EventScope, event: AnyEventPoint, listener: UnknownListener): () => void {
    this.#assertMode(event);
    const records = this.#listeners.get(event.name) ?? [];
    if (!this.#listeners.has(event.name)) this.#listeners.set(event.name, records);
    const record = { scopeId: scope.id, callback: listener };
    records.push(record);
    return () => {
      const index = records.indexOf(record);
      if (index < 0) return;
      records.splice(index, 1);
    };
  }

  emit(scope: EventScope, event: AnyEventPoint, args: unknown[]): void {
    this.#assertDispatchMode(event, 'emit');
    for (const listener of this.#visible(scope, event.name)) listener(...args);
  }

  async parallel(
    scope: EventScope,
    event: AnyEventPoint,
    signal: AbortLike,
    args: unknown[],
  ): Promise<void> {
    this.#assertDispatchMode(event, 'parallel');
    if (signal.aborted) throw new DispatchAbortedError(event.name);
    const results = await Promise.allSettled(
      this.#visible(scope, event.name).map((listener) =>
        abortable(event.name, signal, () => listener(signal, ...args)),
      ),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (errors.length > 0) throw new AggregateError(errors, `容器事件 "${event.name}" 的观察者失败。`);
  }

  async serial(
    scope: EventScope,
    event: AnyEventPoint,
    signal: AbortLike,
    args: unknown[],
  ): Promise<unknown> {
    this.#assertDispatchMode(event, 'serial');
    for (const listener of this.#visible(scope, event.name)) {
      const result = await abortable(event.name, signal, () => listener(signal, ...args));
      if (isBailed(result)) return result;
    }
    return undefined;
  }

  async waterfall<R>(
    scope: EventScope,
    event: AnyEventPoint,
    signal: AbortLike,
    args: unknown[],
    inner: WaterfallNext<R>,
  ): Promise<R> {
    this.#assertDispatchMode(event, 'waterfall');
    const listeners = [...this.#visible(scope, event.name)];
    const next = async (): Promise<R> => {
      const listener = listeners.shift();
      if (listener === undefined) return abortable(event.name, signal, inner);
      return abortable(event.name, signal, () =>
        listener(signal, ...args, next) as R | Promise<R>,
      );
    };
    return next();
  }

  #visible(scope: EventScope, name: string): readonly UnknownListener[] {
    return (this.#listeners.get(name) ?? [])
      .filter((record) => record.scopeId === scope.rootId || record.scopeId === scope.id)
      .map((record) => record.callback);
  }

  #assertMode(event: AnyEventPoint): void {
    const existing = this.#modes.get(event.name);
    if (existing !== undefined && existing !== event.mode) {
      throw new EventDefinitionError(event.name, existing, event.mode);
    }
    this.#modes.set(event.name, event.mode);
  }

  #assertDispatchMode(event: AnyEventPoint, expected: EventMode): void {
    if (event.mode !== expected) throw new EventDefinitionError(event.name, event.mode, expected);
    this.#assertMode(event);
  }
}
