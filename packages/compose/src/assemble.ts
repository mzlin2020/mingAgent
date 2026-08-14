import { PluginContainer } from '@xm/kernel';
import { isBuiltinProfileName, trustedBaseline } from './profiles.js';
import {
  ProfileAssemblyError,
  ProfileError,
  ProfileSchema,
  type AssembledProfile,
  type PluginCatalog,
  type Profile,
  type ProfileRow,
} from './types.js';

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const assertBaseline = (profile: Profile): void => {
  if (!isBuiltinProfileName(profile.name)) {
    throw new ProfileError(`未知内建 profile：${profile.name}`);
  }
  const expected = trustedBaseline(profile.name);
  const baselineRows = profile.rows.filter((row) => row.id.startsWith('baseline.'));
  if (baselineRows.length !== expected.length) {
    throw new ProfileError(`profile ${profile.name} 的基线行数量不符。`);
  }
  const actual = profile.rows.slice(0, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const found = actual[index];
    if (wanted === undefined || found === undefined) {
      throw new ProfileError(`profile ${profile.name} 的基线行索引不完整。`);
    }
    if (
      wanted.id !== found.id ||
      wanted.plugin !== found.plugin ||
      !sameList(wanted.inject, found.inject) ||
      !sameList(wanted.provide, found.provide)
    ) {
      throw new ProfileError(`profile ${profile.name} 的基线行被删除、替换或重排。`);
    }
  }
};

const assertMetadata = <S extends object>(
  row: ProfileRow,
  plugin: ReturnType<PluginCatalog<S>[string]>,
): void => {
  const inject = plugin.inject ?? [];
  const provide = plugin.provide ?? [];
  if (!sameList(row.inject, inject) || !sameList(row.provide, provide)) {
    throw new ProfileAssemblyError(row.id, row.plugin, '的 inject/provide 与 profile 元数据不一致。');
  }
};

export const assembleProfile = async <S extends object>(options: {
  readonly profile: Profile;
  readonly catalog: PluginCatalog<S>;
}): Promise<AssembledProfile<S>> => {
  const profile = ProfileSchema.parse(options.profile);
  assertBaseline(profile);
  const container = new PluginContainer<S>();
  try {
    for (const row of profile.rows) {
      const factory = options.catalog[row.plugin];
      if (factory === undefined) {
        throw new ProfileAssemblyError(row.id, row.plugin, '没有可用的插件实现。');
      }
      const plugin = factory(row);
      assertMetadata(row, plugin);
      container.use({ ...plugin, name: row.id });
    }
    await container.start();
  } catch (error) {
    await container.dispose();
    throw error;
  }
  return {
    container,
    profile,
    rows: profile.rows,
    dispose: () => container.dispose(),
  };
};
