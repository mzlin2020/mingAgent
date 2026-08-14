import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILE_NAMES,
  ProfileError,
  ProfilePatchSchema,
  applyProfilePatch,
  baselineOnlyProfile,
  builtinProfile,
  dumpProfile,
  loadPatchedProfile,
} from '@xm/compose';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('M3-b 内建 profile 与 patch', () => {
  it('desktop/headless/cli/test 四份 profile 共享同序基线，入口行各自明确', () => {
    expect(BUILTIN_PROFILE_NAMES).toEqual(['desktop', 'headless', 'cli', 'test']);
    const profiles = BUILTIN_PROFILE_NAMES.map(builtinProfile);
    const baselineIds = profiles.map((profile) =>
      profile.rows.filter((row) => row.id.startsWith('baseline.')).map((row) => row.id),
    );

    expect(new Set(baselineIds.map((ids) => JSON.stringify(ids))).size).toBe(1);
    expect(profiles.map((profile) => profile.rows.at(-1)?.id)).toEqual([
      'surface.desktop',
      'surface.headless',
      'surface.cli',
      'surface.test',
    ]);
    expect(builtinProfile('test').rows.find((row) => row.id === 'baseline.clock')?.plugin)
      .toBe('@xm/kernel#deterministicClock');
  });

  it('用户 patch 只能更新业务行 config 或按锚点插入新行', () => {
    const patched = applyProfilePatch(builtinProfile('desktop'), {
      update: [{ id: 'tools.builtin', config: { disabled: ['web.fetch'] } }],
      insert: [{
        after: 'tools.builtin',
        row: {
          id: 'tools.extra',
          plugin: '@example/extra#tools',
          inject: ['tools'],
          provide: [],
          config: { enabled: true },
        },
      }],
    });

    expect(patched.rows.find((row) => row.id === 'tools.builtin')?.config)
      .toEqual({ disabled: ['web.fetch'] });
    expect(patched.rows.map((row) => row.id).indexOf('tools.extra'))
      .toBe(patched.rows.map((row) => row.id).indexOf('tools.builtin') + 1);
  });

  it('未知 id、基线更新与伪造 update.plugin 均失败关闭', () => {
    expect(() => applyProfilePatch(builtinProfile('desktop'), {
      update: [{ id: 'tools.missing', config: {} }],
    })).toThrow(ProfileError);
    expect(() => applyProfilePatch(builtinProfile('desktop'), {
      update: [{ id: 'baseline.gateway', config: {} }],
    })).toThrow(/baseline\.gateway.*不可 patch/u);
    expect(() => ProfilePatchSchema.parse({
      update: [{ id: 'tools.builtin', plugin: '@evil/gateway', config: {} }],
    })).toThrow();
  });

  it('空业务 profile 只保留基线，工具注册服务仍在基线内', () => {
    const profile = baselineOnlyProfile('headless');
    expect(profile.rows.every((row) => row.id.startsWith('baseline.'))).toBe(true);
    expect(profile.rows.some((row) => row.id === 'baseline.tools')).toBe(true);
  });

  it('dump-config 对最终 config 做递归脱敏', () => {
    const profile = applyProfilePatch(builtinProfile('desktop'), {
      update: [{ id: 'tools.builtin', config: { apiKey: 'sk-secret-value', nested: { token: 'abc' } } }],
    });
    const dumped = dumpProfile(profile);

    expect(dumped).not.toContain('sk-secret-value');
    expect(dumped).not.toContain('"abc"');
    expect(dumped).toContain('***');
  });

  it('只读取用户 config/profiles，项目目录里的 .xiaoming patch 完全不参与', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xm-profile-'));
    roots.push(root);
    const configDir = join(root, 'config');
    const projectDir = join(root, 'project');
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await mkdir(join(projectDir, '.xiaoming'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'desktop.patch.json'), JSON.stringify({
      update: [{ id: 'tools.builtin', config: { source: 'user-config' } }],
    }));
    await writeFile(join(projectDir, '.xiaoming', 'profile.patch.json'), JSON.stringify({
      update: [{ id: 'tools.builtin', config: { source: 'project' } }],
    }));

    const profile = await loadPatchedProfile({ name: 'desktop', configDir });

    expect(profile.rows.find((row) => row.id === 'tools.builtin')?.config)
      .toEqual({ source: 'user-config' });
  });
});
