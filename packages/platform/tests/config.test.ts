import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPlaintextSecrets } from '@xm/contracts';
import type { XmPaths } from '@xm/kernel';
import { loadConfig, parseModelRef } from '@xm/platform';

/**
 * 配置加载。
 *
 * 在这一段之前，`Config` schema、`mergeConfigLayers`、`restrictSessionPatch` 全都写好了
 * 但**没有任何代码读过一个配置文件**——那套东西一直是纯纸面的。这些用例是它第一次
 * 被真实文件喂到。
 */

let dir: string;
let paths: XmPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-config-'));
  paths = {
    home: dir,
    appRoot: dir,
    data: join(dir, 'data'),
    config: join(dir, 'config'),
    cache: join(dir, 'cache'),
    logs: join(dir, 'logs'),
  };
  await mkdir(paths.config, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeUser = (json: unknown): Promise<void> =>
  writeFile(join(paths.config, 'config.json'), JSON.stringify(json));

const writeProject = async (json: unknown): Promise<void> => {
  await mkdir(join(dir, '.xiaoming'), { recursive: true });
  await writeFile(join(dir, '.xiaoming', 'config.json'), JSON.stringify(json));
};

describe('分层与合并', () => {
  it('没有任何配置文件时用内置默认，且不报问题', async () => {
    const { config, problems } = await loadConfig({ paths });
    expect(config.permission.rules).toEqual([]);
    expect(config.logging.redact).toBe(true);
    expect(problems).toEqual([]);
  });

  it('项目级覆盖用户级', async () => {
    await writeUser({ logging: { level: 'debug' } });
    await writeProject({ logging: { level: 'error' } });
    const { config } = await loadConfig({ paths, cwd: dir });
    expect(config.logging.level).toBe('error');
  });

  it('数组整体替换，不拼接（schema.ts 定死的语义）', async () => {
    await writeUser({ tools: { disabled: ['a', 'b'] } });
    await writeProject({ tools: { disabled: ['c'] } });
    const { config } = await loadConfig({ paths, cwd: dir });
    expect(config.tools.disabled).toEqual(['c']);
  });
});

describe('失败关闭', () => {
  it('🔴 JSON 坏掉时退回内置默认并报问题，不是让应用起不来', async () => {
    await writeFile(join(paths.config, 'config.json'), '{ 这不是 JSON');
    const { config, problems } = await loadConfig({ paths });
    // 起不来的话，用户连改配置的界面都打不开
    expect(config.logging.redact).toBe(true);
    expect(problems.map((p) => p.code)).toContain('config.unreadable');
  });

  it('🔴 配置不合法时退回默认并报问题', async () => {
    await writeUser({ logging: { level: '随便写的级别' } });
    const { config, problems } = await loadConfig({ paths });
    expect(config.logging.level).toBe('info');
    expect(problems.map((p) => p.code)).toContain('config.invalid');
  });

  it('顶层不是对象时忽略这一层', async () => {
    await writeFile(join(paths.config, 'config.json'), '[1,2,3]');
    const { problems } = await loadConfig({ paths });
    expect(problems.map((p) => p.code)).toContain('config.unreadable');
  });
});

describe('明文密钥', () => {
  it('🔴 配置里写明文 apiKey 会被点名，且给出照着改的那句话', async () => {
    await writeUser({
      providers: { anthropic: { kind: 'anthropic', apiKey: 'sk-ant-whatever' } },
    });
    const { problems } = await loadConfig({ paths });

    const finding = problems.find((p) => p.code === 'config.plaintext_secret');
    expect(finding).toBeDefined();
    // 报错必须指出**哪个键**，否则用户在一棵配置树里找不着
    expect(finding!.message).toContain('providers.anthropic.apiKey');
    expect(finding!.message).toContain('$secret');
  });

  it('SecretRef 形态的引用不会被误报', async () => {
    await writeUser({
      providers: { anthropic: { kind: 'anthropic', apiKey: { $secret: 'anthropic.apiKey' } } },
    });
    const { problems, config } = await loadConfig({ paths });
    expect(problems.filter((p) => p.code === 'config.plaintext_secret')).toEqual([]);
    expect(config.providers.anthropic?.apiKey).toEqual({ $secret: 'anthropic.apiKey' });
  });

  it('🔴 扫描器认各种拼法，也认嵌套与数组里的', () => {
    const found = findPlaintextSecrets({
      providers: { a: { apiKey: 'x' }, b: { api_key: 'y' } },
      list: [{ token: 'z' }],
      nested: { deep: { password: 'p' } },
      innocent: { note: '这不是密钥' },
    });
    expect(found.map((f) => f.path).sort()).toEqual([
      'list[0].token',
      'nested.deep.password',
      'providers.a.apiKey',
      'providers.b.api_key',
    ]);
  });

  it('🔴 短到不像密钥的值同样算 —— 只看键名，不看值', () => {
    // 看值的实现会漏掉"回头再换成真的"这种占位符，而它经常就是真的
    expect(findPlaintextSecrets({ apiKey: 'x' })).toHaveLength(1);
  });
});

describe('parseModelRef', () => {
  it('拆 provider 与 model', () => {
    expect(parseModelRef('anthropic/claude-opus-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('模型名里含斜杠时只按第一个斜杠拆', () => {
    expect(parseModelRef('my-proxy/org/model-1')).toEqual({
      provider: 'my-proxy',
      model: 'org/model-1',
    });
  });
});
