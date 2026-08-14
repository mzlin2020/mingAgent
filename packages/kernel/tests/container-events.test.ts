import { describe, expect, it } from 'vitest';
import {
  DispatchAbortedError,
  PluginContainer,
  defineEmitEvent,
  defineParallelEvent,
  defineSerialEvent,
  defineWaterfallEvent,
} from '@xm/kernel';
import type { AbortLike } from '@xm/kernel';

class TestSignal implements AbortLike {
  aborted = false;
  readonly #listeners = new Set<() => void>();

  addEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  abort(): void {
    this.aborted = true;
    for (const listener of this.#listeners) listener();
  }
}

describe('插件容器：四种类型化派发', () => {
  it('emit 按注册序同步通知，不等待返回值', () => {
    const event = defineEmitEvent<[value: string]>('test/emit');
    const container = new PluginContainer();
    const trace: string[] = [];
    container.context.on(event, (value) => trace.push(`a:${value}`));
    container.context.on(event, (value) => trace.push(`b:${value}`));

    container.context.emit(event, 'x');
    expect(trace).toEqual(['a:x', 'b:x']);
  });

  it('serial 按序等待，并在第一个 bail 值处停止', async () => {
    const event = defineSerialEvent<[value: number], string>('test/serial');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const trace: number[] = [];
    container.context.on(event, async (_signal, value) => {
      trace.push(1);
      await Promise.resolve();
      return value > 0 ? undefined : 'no';
    });
    container.context.on(event, (listenerSignal, value) => {
      void listenerSignal;
      void value;
      trace.push(2);
      return 'stop';
    });
    container.context.on(event, (listenerSignal, value) => {
      void listenerSignal;
      void value;
      trace.push(3);
      return 'late';
    });

    await expect(container.context.serial(event, signal, 1)).resolves.toBe('stop');
    expect(trace).toEqual([1, 2]);
  });

  it('waterfall 是 await 的环绕链；不调 next 即短路', async () => {
    const event = defineWaterfallEvent<[value: number], number>('test/waterfall');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const trace: string[] = [];
    container.context.on(event, async (_signal, value, next) => {
      trace.push(`before:${String(value)}`);
      const result = await next();
      trace.push(`after:${String(result)}`);
      return result + 1;
    });
    container.context.on(event, async () => {
      trace.push('short');
      await Promise.resolve();
      return 10;
    });
    container.context.on(event, async (_signal, _value, next) => {
      trace.push('never');
      return next();
    });

    await expect(container.context.waterfall(event, signal, 2, () => 0)).resolves.toBe(11);
    expect(trace).toEqual(['before:2', 'short', 'after:10']);
  });

  it('waterfall 重入按两次独立派发处理', async () => {
    const event = defineWaterfallEvent<[depth: number], number>('test/reentrant');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const seen: number[] = [];
    container.context.on(event, async (_signal, depth, next) => {
      seen.push(depth);
      if (depth === 0) {
        return container.context.waterfall(event, signal, 1, () => 1);
      }
      return next();
    });

    await expect(container.context.waterfall(event, signal, 0, () => 0)).resolves.toBe(1);
    expect(seen).toEqual([0, 1]);
  });

  it('取消能打断等待永不 resolve 的 waterfall 监听器', async () => {
    const event = defineWaterfallEvent<[], undefined>('test/abort');
    const container = new PluginContainer();
    const signal = new TestSignal();
    container.context.on(event, () => new Promise<undefined>(() => undefined));

    const pending = container.context.waterfall(event, signal, () => undefined);
    signal.abort();

    await expect(pending).rejects.toBeInstanceOf(DispatchAbortedError);
  });

  it('parallel 等全部观察者结束后抛 AggregateError，不让一个失败者跳过其它观察者', async () => {
    const event = defineParallelEvent<[value: string]>('test/parallel');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const trace: string[] = [];
    container.context.on(event, async (listenerSignal, value) => {
      void listenerSignal;
      void value;
      trace.push('bad');
      await Promise.resolve();
      throw new Error('boom');
    });
    container.context.on(event, async (_signal, value) => {
      await Promise.resolve();
      trace.push(value);
    });

    await expect(container.context.parallel(event, signal, 'good')).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(trace).toEqual(['bad', 'good']);
  });

  it('serial / waterfall 错误原样上抛，后续监听器不执行', async () => {
    const event = defineSerialEvent<[], string>('test/error');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const error = new Error('original');
    let later = false;
    container.context.on(event, () => {
      throw error;
    });
    container.context.on(event, () => {
      later = true;
      return 'late';
    });

    await expect(container.context.serial(event, signal)).rejects.toBe(error);
    expect(later).toBe(false);
  });

  it('插件卸载后，它注册的监听器全部消失', async () => {
    const event = defineEmitEvent<[]>('test/plugin-unload');
    const container = new PluginContainer();
    let calls = 0;
    const handle = container.use({
      name: 'listener-owner',
      apply(ctx) {
        ctx.on(event, () => {
          calls += 1;
        });
      },
    });
    await container.start();
    container.context.emit(event);

    await handle.dispose();
    container.context.emit(event);

    expect(calls).toBe(1);
  });

  it('waterfall 监听器的错误也保持同一对象原样上抛', async () => {
    const event = defineWaterfallEvent<[], number>('test/waterfall-error');
    const container = new PluginContainer();
    const signal = new TestSignal();
    const error = new Error('waterfall-original');
    container.context.on(event, () => {
      throw error;
    });

    await expect(container.context.waterfall(event, signal, () => 1)).rejects.toBe(error);
  });
});
