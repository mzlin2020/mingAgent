import { describe, expect, it } from 'vitest';
import { Config, SecretRef, isSecretRef, mergeConfig, mergeConfigLayers } from '@xm/contracts';

/**
 * 配置合并语义 —— docs/10 §8。
 *
 * 数组语义是最容易含糊的地方："项目配置里的工具禁用列表"到底是覆盖还是追加？
 * 含糊一次就会有安全事故（以为禁掉了，实际被合并没了）。所以这里把它测死。
 */
describe('mergeConfig', () => {
  it('对象深合并', () => {
    expect(mergeConfig({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });

  it('数组整体替换，不是拼接', () => {
    expect(mergeConfig({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('null 表示删除该键', () => {
    expect(mergeConfig({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it('删除不存在的键是安全的空操作', () => {
    expect(mergeConfig({ a: 1 }, { nope: null })).toEqual({ a: 1 });
  });

  it('标量覆盖', () => {
    expect(mergeConfig({ a: 1 }, { a: 'x' })).toEqual({ a: 'x' });
  });

  it('对象覆盖数组、数组覆盖对象都走整体替换', () => {
    expect(mergeConfig({ a: [1] }, { a: { k: 1 } })).toEqual({ a: { k: 1 } });
    expect(mergeConfig({ a: { k: 1 } }, { a: [1] })).toEqual({ a: [1] });
  });

  it('不修改入参（纯函数）', () => {
    const base = { a: { x: 1 } };
    const patch = { a: { y: 2 } };
    mergeConfig(base, patch);
    expect(base).toEqual({ a: { x: 1 } });
    expect(patch).toEqual({ a: { y: 2 } });
  });

  it('分层顺序：内置 < 用户 < 项目 < 会话', () => {
    const merged = mergeConfigLayers(
      { model: { main: '内置' }, tools: { disabled: [] } },
      { model: { main: '用户' } },
      { tools: { disabled: ['shell.exec'] } },
      { model: { main: '会话' } },
    );
    expect(merged).toEqual({ model: { main: '会话' }, tools: { disabled: ['shell.exec'] } });
  });
});

describe('配置树与 SecretRef', () => {
  it('完整配置能通过校验，缺省值被填上', () => {
    const cfg = Config.parse({
      model: { main: 'anthropic/claude-opus-5' },
      permission: {},
      tools: {},
      logging: {},
    });
    expect(cfg.permission.tier).toBe('balanced');
    expect(cfg.logging.redact).toBe(true);
    expect(cfg.providers).toEqual({});
  });

  it('apiKey 只接受 SecretRef，明文字符串被拒', () => {
    const withPlaintext = {
      model: { main: 'm' },
      permission: {},
      tools: {},
      logging: {},
      providers: { anthropic: { kind: 'anthropic', apiKey: 'sk-ant-plaintext' } },
    };
    expect(() => Config.parse(withPlaintext)).toThrow();
  });

  it('SecretRef 形状正确时通过', () => {
    const cfg = Config.parse({
      model: { main: 'm' },
      permission: {},
      tools: {},
      logging: {},
      providers: { anthropic: { kind: 'anthropic', apiKey: { $secret: 'anthropic.apiKey' } } },
    });
    expect(cfg.providers.anthropic?.apiKey).toEqual({ $secret: 'anthropic.apiKey' });
  });

  it('isSecretRef 只认严格形状', () => {
    expect(isSecretRef({ $secret: 'a' })).toBe(true);
    expect(isSecretRef({ $secret: 'a', extra: 1 })).toBe(false);
    expect(isSecretRef('sk-ant-xxx')).toBe(false);
    expect(SecretRef.safeParse({ $secret: '' }).success).toBe(false);
  });
});
