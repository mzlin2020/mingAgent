import { describe, expect, it } from 'vitest';
import type { ContainerPlugin } from '@xm/kernel';
import {
  ProfileAssemblyError,
  applyProfilePatch,
  assembleProfile,
  baselineOnlyProfile,
  builtinProfile,
  type PluginCatalog,
  type Profile,
  type ProfileRow,
} from '@xm/compose';

type Services = Record<string, string>;

const pluginFor = (row: ProfileRow): ContainerPlugin<Services> => ({
  name: row.id,
  inject: row.inject,
  provide: row.provide,
  apply(ctx) {
    for (const key of row.provide) ctx.provide(key, row.id);
  },
});

const catalogFor = (profile: Profile): PluginCatalog<Services> =>
  Object.fromEntries(profile.rows.map((row) => [row.plugin, pluginFor]));

describe('M3-b profile 装配', () => {
  it('空业务 profile 能启动，基线服务全部在位且 tools 为空', async () => {
    const profile = baselineOnlyProfile('headless');
    const assembled = await assembleProfile({ profile, catalog: catalogFor(profile) });

    expect(assembled.container.context.gateway).toBe('baseline.gateway');
    expect(assembled.container.context.tools).toBe('baseline.tools');
    expect(assembled.rows.every((row) => row.id.startsWith('baseline.'))).toBe(true);
    await assembled.dispose();
  });

  it('缺少插件实现时指名 profile 行与 plugin 引用', async () => {
    const profile = baselineOnlyProfile('headless');
    const catalog = catalogFor(profile);
    delete catalog['@xm/tool-runtime#gateway'];

    await expect(assembleProfile({ profile, catalog })).rejects.toMatchObject({
      name: 'ProfileAssemblyError',
      message: expect.stringMatching(/baseline\.gateway.*@xm\/tool-runtime#gateway/u),
    });
  });

  it('插件实际 inject/provide 与 profile 元数据漂移时拒绝装配', async () => {
    const profile = baselineOnlyProfile('headless');
    const catalog = catalogFor(profile);
    catalog['@xm/tool-runtime#gateway'] = (row) => ({
      ...pluginFor(row),
      provide: [],
    });

    await expect(assembleProfile({ profile, catalog })).rejects.toBeInstanceOf(ProfileAssemblyError);
  });

  it('业务行不能插入特权基线之间', async () => {
    const profile = builtinProfile('headless');
    const business = profile.rows.pop();
    if (business === undefined) throw new Error('测试 profile 缺少业务行。');
    profile.rows.splice(1, 0, business);

    await expect(assembleProfile({ profile, catalog: catalogFor(profile) }))
      .rejects.toThrow(/基线行被删除、替换或重排/u);
  });

  it('业务插件冒充基线服务时由装配收敛拒绝，不覆盖真实基线', async () => {
    const profile = applyProfilePatch(builtinProfile('headless'), {
      insert: [{
        after: 'tools.builtin',
        row: {
          id: 'evil.policy',
          plugin: '@evil/plugin#policy',
          inject: [],
          provide: ['policy'],
        },
      }],
    });
    const catalog = catalogFor(profile);

    await expect(assembleProfile({ profile, catalog })).rejects.toThrow(/policy.*冲突/u);
  });
});
