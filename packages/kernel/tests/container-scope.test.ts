import { describe, expect, it } from 'vitest';
import { PluginContainer, defineEmitEvent } from '@xm/kernel';

interface Services {
  root: string;
  local: string;
}

describe('插件容器：两级扁平作用域（ADR-0067）', () => {
  it('孙层只继承根服务，不继承父 fork 的局部服务', () => {
    const container = new PluginContainer<Services>();
    container.provide('root', 'baseline');
    const parent = container.context.fork();
    parent.provide('local', 'parent-only');

    const child = parent.fork();

    expect(child.root).toBe('baseline');
    expect(child.has('local')).toBe(false);
    expect(() => child.local).toThrow(/local.*未提供/);
  });

  it('fork 可以显式覆盖根服务，但不影响根和兄弟作用域', () => {
    const container = new PluginContainer<Services>();
    container.provide('root', 'baseline');
    const left = container.context.fork();
    const right = container.context.fork();
    left.provide('root', 'left');

    expect(left.root).toBe('left');
    expect(right.root).toBe('baseline');
    expect(container.context.root).toBe('baseline');
  });

  it('监听器可见性同样只有根层与本层', () => {
    const event = defineEmitEvent<[value: string]>('test/scope');
    const container = new PluginContainer<Services>();
    const parent = container.context.fork();
    const child = parent.fork();
    const trace: string[] = [];
    container.context.on(event, (value) => trace.push(`root:${value}`));
    parent.on(event, (value) => trace.push(`parent:${value}`));
    child.on(event, (value) => trace.push(`child:${value}`));

    child.emit(event, 'x');

    expect(trace).toEqual(['root:x', 'child:x']);
  });

  it('解析虽扁平，父作用域卸载仍级联清理全部后代效果', async () => {
    const container = new PluginContainer<Services>();
    const parent = container.context.fork();
    const child = parent.fork();
    const trace: string[] = [];
    child.effect(() => {
      trace.push('setup');
      return () => trace.push('child-disposed');
    });

    await parent.dispose();

    expect(trace).toEqual(['setup', 'child-disposed']);
    expect(parent.active).toBe(false);
    expect(child.active).toBe(false);
    expect(() => child.effect(() => undefined)).toThrow(/已卸载/);
  });

  it('卸载插件时一并清理插件创建的 fork', async () => {
    const container = new PluginContainer<Services>();
    let child: ReturnType<typeof container.context.fork> | undefined;
    const trace: string[] = [];
    const handle = container.use({
      name: 'fork-owner',
      apply(ctx) {
        child = ctx.fork();
        child.effect(() => () => trace.push('fork-disposed'));
      },
    });
    await container.start();

    await handle.dispose();

    expect(child?.active).toBe(false);
    expect(trace).toEqual(['fork-disposed']);
  });

  it('根上下文卸载会走完整容器生命周期，且卸载后不可重新装配', async () => {
    const event = defineEmitEvent<[]>('test/root-dispose');
    const container = new PluginContainer<Services>();
    const trace: string[] = [];
    const handle = container.use({
      name: 'root-owned-plugin',
      apply(ctx) {
        ctx.on(event, () => trace.push('leaked'));
        ctx.effect(() => () => trace.push('plugin-disposed'));
      },
    });
    await container.start();

    await container.context.dispose();

    expect(handle.state).toBe('disposed');
    expect(container.context.active).toBe(false);
    expect(trace).toEqual(['plugin-disposed']);
    expect(() => container.use({ name: 'late', apply: () => undefined })).toThrow(/已卸载/);
    await expect(container.start()).rejects.toThrow(/已卸载/);
  });
});
