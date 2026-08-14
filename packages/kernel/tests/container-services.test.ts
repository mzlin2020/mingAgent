import { describe, expect, it } from 'vitest';
import {
  ContainerDependencyError,
  PluginContainer,
  PluginProvideError,
  ServiceConflictError,
} from '@xm/kernel';

interface Services {
  alpha: string;
  beta: number;
  missing: boolean;
}

describe('插件容器：服务与装配收敛', () => {
  it('按 inject / provide 图装配，不依赖注册顺序', async () => {
    const order: string[] = [];
    const container = new PluginContainer<Services>();
    container.use({
      name: 'consumer',
      inject: ['alpha'],
      provide: ['beta'],
      apply(ctx) {
        order.push(`consumer:${ctx.alpha}`);
        ctx.provide('beta', ctx.alpha.length);
      },
    });
    container.use({
      name: 'provider',
      provide: ['alpha'],
      apply(ctx) {
        order.push('provider');
        ctx.provide('alpha', 'hello');
      },
    });

    await container.start();

    expect(order).toEqual(['provider', 'consumer:hello']);
    expect(container.context.beta).toBe(5);
  });

  it('卸载插件会撤销它提供的服务与全部效果', async () => {
    const trace: string[] = [];
    const container = new PluginContainer<Services>();
    const handle = container.use({
      name: 'provider',
      provide: ['alpha'],
      apply(ctx) {
        ctx.provide('alpha', 'live');
        ctx.effect(() => {
          trace.push('setup');
          return () => trace.push('dispose');
        });
      },
    });
    await container.start();

    expect(container.context.alpha).toBe('live');
    await handle.dispose();

    expect(container.context.has('alpha')).toBe(false);
    expect(trace).toEqual(['setup', 'dispose']);
  });

  it('缺少提供者时 fail loud，并指名插件与服务', async () => {
    const container = new PluginContainer<Services>();
    container.use({ name: 'waiting', inject: ['missing'], apply: () => undefined });

    await expect(container.start()).rejects.toMatchObject({
      name: 'ContainerDependencyError',
      message: expect.stringMatching(/waiting.*missing.*无提供者/),
    });
  });

  it('依赖环打印完整插件 / 服务链', async () => {
    const container = new PluginContainer<Services>();
    container.use({
      name: 'plugin-a',
      inject: ['beta'],
      provide: ['alpha'],
      apply(ctx) {
        ctx.provide('alpha', 'a');
      },
    });
    container.use({
      name: 'plugin-b',
      inject: ['alpha'],
      provide: ['beta'],
      apply(ctx) {
        ctx.provide('beta', 1);
      },
    });

    await expect(container.start()).rejects.toThrow(
      /plugin-a -> beta -> plugin-b -> alpha -> plugin-a/,
    );
  });

  it('插件不得提供未声明的服务', async () => {
    const container = new PluginContainer<Services>();
    container.use({
      name: 'undeclared',
      apply(ctx) {
        ctx.provide('alpha', 'oops');
      },
    });

    await expect(container.start()).rejects.toBeInstanceOf(PluginProvideError);
    expect(container.context.has('alpha')).toBe(false);
  });

  it('声明 provide 却没有真实注册时回滚插件效果', async () => {
    const trace: string[] = [];
    const container = new PluginContainer<Services>();
    container.use({
      name: 'forgotten',
      provide: ['alpha'],
      apply(ctx) {
        ctx.effect(() => {
          trace.push('setup');
          return () => trace.push('rollback');
        });
      },
    });

    await expect(container.start()).rejects.toBeInstanceOf(PluginProvideError);
    expect(trace).toEqual(['setup', 'rollback']);
  });

  it('同一作用域双提供失败，且 start 整体回滚已启动插件', async () => {
    const container = new PluginContainer<Services>();
    container.use({
      name: 'first',
      provide: ['alpha'],
      apply(ctx) {
        ctx.provide('alpha', 'first');
      },
    });
    container.use({
      name: 'second',
      provide: ['alpha'],
      apply(ctx) {
        ctx.provide('alpha', 'second');
      },
    });

    await expect(container.start()).rejects.toBeInstanceOf(ServiceConflictError);
    expect(container.context.has('alpha')).toBe(false);
  });

  it('诊断错误保留结构化等待项，调用方不必解析中文文案', async () => {
    const container = new PluginContainer<Services>();
    container.use({ name: 'waiting', inject: ['missing'], apply: () => undefined });
    try {
      await container.start();
      expect.unreachable('应该失败');
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerDependencyError);
      expect((error as ContainerDependencyError).waiting).toEqual([
        { plugin: 'waiting', services: ['missing'] },
      ]);
    }
  });

  it('装配后才发现后续插件缺依赖时，已启动插件也整体回滚', async () => {
    const container = new PluginContainer<Services>();
    container.use({
      name: 'started-first',
      provide: ['alpha'],
      apply(ctx) {
        ctx.provide('alpha', 'temporary');
      },
    });
    container.use({ name: 'still-waiting', inject: ['missing'], apply: () => undefined });

    await expect(container.start()).rejects.toBeInstanceOf(ContainerDependencyError);
    expect(container.context.has('alpha')).toBe(false);
  });

  it('同一所有者的效果按注册反序撤销', async () => {
    const trace: string[] = [];
    const container = new PluginContainer<Services>();
    const handle = container.use({
      name: 'lifo',
      apply(ctx) {
        ctx.effect(() => () => trace.push('first'));
        ctx.effect(() => () => trace.push('second'));
      },
    });
    await container.start();

    await handle.dispose();

    expect(trace).toEqual(['second', 'first']);
  });

  it('插件上下文自行卸载时同步句柄状态', async () => {
    const container = new PluginContainer<Services>();
    let pluginContext: typeof container.context | undefined;
    const handle = container.use({
      name: 'self-dispose',
      provide: ['alpha'],
      apply(ctx) {
        pluginContext = ctx;
        ctx.provide('alpha', 'temporary');
      },
    });
    await container.start();

    await pluginContext?.dispose();

    expect(handle.state).toBe('disposed');
    expect(container.context.has('alpha')).toBe(false);
  });
});
