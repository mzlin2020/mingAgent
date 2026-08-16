import { describe, expect, it } from 'vitest';
import type { Config, PolicyRuleSet } from '@xm/contracts';
import { mergeConfig } from '@xm/contracts';
import type { UpdateSettingsRequest } from '../src/shared/ipc-settings.js';
import {
  assertSettingsUpdate,
  buildSettingsPatch,
  nextConfig,
  nextDisabledTools,
  nextProviders,
  nextUserRules,
  providersPersistRecord,
  recordReplacePatch,
} from '../src/main/settings-update.js';

const current: Config = {
  model: { main: 'openai/gpt' },
  providers: {
    openai: { kind: 'openai-compatible', models: [], apiKey: { $secret: 'openai.apiKey' } },
  },
  prices: { 'openai/gpt': { input: 1, output: 2 } },
  permission: { rules: [] },
  tools: { disabled: [], presentation: 'native' },
  workspace: { mode: 'choose' },
};

const deny = (id: string): UpdateSettingsRequest['permissionDenies'][number] => ({
  id,
  effect: 'deny',
  capability: 'fs.write',
  reason: '不要写',
});

const valid = (): UpdateSettingsRequest => ({
  workspace: { mode: 'home' },
  disabledTools: ['fs.write'],
  presentation: 'code',
  model: { main: 'openai/gpt-4' },
  providers: [{ id: 'openai', kind: 'openai-compatible', models: ['gpt-4'] }],
  prices: { 'openai/gpt-4': { input: 3, output: 4 } },
  permissionDenies: [deny('user.no-write')],
});

describe('assertSettingsUpdate', () => {
  it('固定目录缺路径就拒绝', () => {
    expect(() => {
      assertSettingsUpdate({ ...valid(), workspace: { mode: 'fixed' } });
    }).toThrow(/必须先选择一个目录/);
  });

  it('重复的 Provider ID 就拒绝', () => {
    expect(() => {
      assertSettingsUpdate({
        ...valid(),
        providers: [
          { id: 'openai', kind: 'openai-compatible', models: [] },
          { id: 'openai', kind: 'anthropic', models: ['claude'] },
        ],
      });
    }).toThrow(/不能重复/);
  });
});

describe('nextUserRules', () => {
  it('保存 deny 时保留手写 allow，不把它们从文件里抹掉', () => {
    const existing: PolicyRuleSet = [
      {
        id: 'hand.allow',
        effect: 'allow',
        capability: 'git.push',
        reason: '我知道自己在干什么',
        immutable: false,
      },
      {
        id: 'old.deny',
        effect: 'deny',
        capability: 'fs.delete',
        reason: '旧的拒绝',
        immutable: false,
      },
    ];
    const next = nextUserRules(existing, [deny('user.no-write')]);
    expect(next.map((rule) => rule.id)).toEqual(['hand.allow', 'user.no-write']);
    expect(next[0]?.effect).toBe('allow');
  });
});

describe('nextProviders', () => {
  it('改 kind / baseUrl 时保住已有 SecretRef，不把密钥写进补丁', () => {
    const next = nextProviders(current.providers, [
      { id: 'openai', kind: 'openai-compatible', baseUrl: 'https://example.test', models: [] },
    ]);
    expect(next.openai?.apiKey).toEqual({ $secret: 'openai.apiKey' });
    expect(next.openai?.baseUrl).toBe('https://example.test');
  });
});

describe('recordReplacePatch', () => {
  it('删掉的 id 显式 null，深合并才真的拿得掉', () => {
    expect(recordReplacePatch('prices', { a: 1, b: 2 }, { a: 3 })).toEqual({
      prices: { a: 3, b: null },
    });
  });
});

describe('nextDisabledTools', () => {
  it('当前注册表里没有的停用项，保存时仍留在名单里', () => {
    expect(nextDisabledTools(['fs.write', 'legacy.tool'], [], new Set(['fs.write']))).toEqual([
      'legacy.tool',
    ]);
    expect(nextDisabledTools(['legacy.tool'], ['fs.write'], new Set(['fs.write']))).toEqual([
      'fs.write',
      'legacy.tool',
    ]);
  });
});

describe('nextConfig / buildSettingsPatch', () => {
  it('内存配置不把用户规则写进 config.permission.rules（加载器那条不变量）', () => {
    const known = new Set(['fs.write']);
    const update = valid();
    const nextProv = nextProviders(current.providers, update.providers);
    const cfg = nextConfig(current, update, nextProv, known);
    expect(cfg.permission.rules).toEqual([]);
    expect(cfg.tools.presentation).toBe('code');
    expect(cfg.model.main).toBe('openai/gpt-4');
  });

  it('清空 Provider Base URL 时补丁写 null，深合并才能删掉旧地址', () => {
    const known = new Set(['fs.write']);
    const currentWithUrl: Config = {
      ...current,
      providers: {
        openai: {
          kind: 'openai-compatible',
          models: [],
          baseUrl: 'https://old.example',
          apiKey: { $secret: 'openai.apiKey' },
        },
      },
    };
    const update = {
      ...valid(),
      providers: [{ id: 'openai', kind: 'openai-compatible' as const, models: [] }],
    };
    const nextProv = nextProviders(currentWithUrl.providers, update.providers);
    expect(nextProv.openai?.baseUrl).toBeUndefined();
    expect(providersPersistRecord(nextProv).openai).toMatchObject({ baseUrl: null });
    const patch = buildSettingsPatch(currentWithUrl, update, nextProv, [], known);
    expect(mergeConfig(currentWithUrl, patch).providers).toEqual({
      openai: { kind: 'openai-compatible', models: [], apiKey: { $secret: 'openai.apiKey' } },
    });
  });

  it('清空 subagent / summarize 时补丁写 null，深合并才能删掉旧值', () => {
    const known = new Set(['fs.write']);
    const update = { ...valid(), model: { main: 'openai/gpt-4' } };
    const currentWithRoles: Config = {
      ...current,
      model: { main: 'openai/gpt', subagent: 'openai/mini', summarize: 'openai/nano' },
    };
    const nextProv = nextProviders(currentWithRoles.providers, update.providers);
    const patch = buildSettingsPatch(currentWithRoles, update, nextProv, [], known);
    expect(patch.model).toEqual({
      main: 'openai/gpt-4',
      subagent: null,
      summarize: null,
    });
    expect(mergeConfig(currentWithRoles, patch).model).toEqual({ main: 'openai/gpt-4' });
  });

  it('补丁里的 permission.rules 含保留的 allow + 新 deny', () => {
    const known = new Set(['fs.write']);
    const update = valid();
    const nextProv = nextProviders(current.providers, update.providers);
    const rules = nextUserRules(
      [{ id: 'hand.allow', effect: 'allow', capability: 'net.fetch', reason: '放行', immutable: false }],
      update.permissionDenies,
    );
    const patch = buildSettingsPatch(current, update, nextProv, rules, known);
    expect(patch.permission).toEqual({ rules });
  });
});
