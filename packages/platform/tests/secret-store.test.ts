import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretUnavailableError } from '@xm/kernel';
import { PASSPHRASE_SENTINEL, fileSecretStore, unavailableSecretStore, verifyPassphrase } from '@xm/platform';

/**
 * SecretStore 的两个非 Electron 实现。
 *
 * ── 最要紧的一条在最后：`plaintext-unavailable` 下 `set()` 必须抛 ──
 *
 * 参考项目那个含真实 API key 且已提交进 git 的 `config.yaml`，不是某个人某天疏忽写出来的，
 * 而是"当时没有别的地方可以放"的必然结果。**只要存在一条"先明文存着，回头再说"的路径，
 * 它就会被走。** 这里用一条用例把那条路径钉死。
 */

let dir: string;
const file = (): string => join(dir, 'secrets.json');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-secrets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('加密文件后端', () => {
  it('存进去再取出来是同一个值', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await store.set({ $secret: 'anthropic.apiKey' }, 'sk-ant-secret-value');
    expect(await store.get({ $secret: 'anthropic.apiKey' })).toBe('sk-ant-secret-value');
  });

  it('🔴 落盘的文件里找不到明文', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await store.set({ $secret: 'k' }, 'sk-ant-super-secret');
    expect(await readFile(file(), 'utf8')).not.toContain('sk-ant-super-secret');
  });

  it('🔴 两个相同的密钥产生不同的密文 —— 否则会泄漏"这两家用的是同一个 key"', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await store.set({ $secret: 'a' }, 'same-key');
    await store.set({ $secret: 'b' }, 'same-key');
    const shape = JSON.parse(await readFile(file(), 'utf8')) as Record<string, { data: string }>;
    expect(shape.a?.data).not.toBe(shape.b?.data);
  });

  it('🔴 口令不对时**抛**，不返回 undefined', async () => {
    await fileSecretStore({ file: file(), passphrase: 'right' }).set({ $secret: 'k' }, 'v');
    const wrong = fileSecretStore({ file: file(), passphrase: 'wrong' });
    /*
     * 返回 undefined 会让上层以为"没配置过"，弹一个录入框，
     * 用户重新输一遍——覆盖掉那条其实还在的密钥。
     */
    await expect(wrong.get({ $secret: 'k' })).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('密文被改动会被认证标签发现，而不是解出垃圾', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await store.set({ $secret: 'k' }, 'value');
    const shape = JSON.parse(await readFile(file(), 'utf8')) as Record<string, { data: string }>;
    shape.k!.data = Buffer.from('tampered').toString('base64');
    await (await import('node:fs/promises')).writeFile(file(), JSON.stringify(shape));

    await expect(store.get({ $secret: 'k' })).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('取一个没存过的键返回 undefined —— "还没配置"是正常状态，不是错误', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    expect(await store.get({ $secret: 'never-set' })).toBeUndefined();
  });

  it('损坏或类型错误的密钥文件显式报错，且 set 不会覆盖原文件', async () => {
    await writeFile(file(), '{broken');
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await expect(store.get({ $secret: 'k' })).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(store.set({ $secret: 'k' }, 'new')).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(await readFile(file(), 'utf8')).toBe('{broken');

    await writeFile(file(), JSON.stringify({ k: { salt: 1, iv: 'a', tag: 'b', data: 'c' } }));
    await expect(store.list()).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('delete 幂等；list 只给键名', async () => {
    const store = fileSecretStore({ file: file(), passphrase: 'pw' });
    await store.set({ $secret: 'a' }, 'v1');
    await store.set({ $secret: 'b' }, 'v2');
    await store.delete({ $secret: 'a' });
    await store.delete({ $secret: 'a' });

    const listed = await store.list();
    expect(listed).toEqual(['b']);
    // 端口注释第一条：list 永远不返回值
    expect(JSON.stringify(listed)).not.toContain('v2');
  });

  it('口令哨兵：首次写入，之后能验对错', async () => {
    const good = fileSecretStore({ file: file(), passphrase: 'pw' });
    expect(await verifyPassphrase(good)).toBe(true);
    expect(await good.list()).toContain(PASSPHRASE_SENTINEL);

    const bad = fileSecretStore({ file: file(), passphrase: 'nope' });
    expect(await verifyPassphrase(bad)).toBe(false);
  });
});

describe('不可用后端', () => {
  it('🔴 set 抛，且报错里说清了两条出路 —— 明文不是其中之一', async () => {
    const store = unavailableSecretStore('测试环境');
    await expect(store.set({ $secret: 'k' }, 'v')).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(store.set({ $secret: 'k' }, 'v')).rejects.toThrow(/钥匙串[\s\S]*口令/);
  });

  it('get 返回 undefined 而不是抛 —— 读不到只是"没配置"', async () => {
    expect(await unavailableSecretStore().get({ $secret: 'k' })).toBeUndefined();
  });

  it('backend 如实报 plaintext-unavailable，UI 据此显示降级横幅', () => {
    expect(unavailableSecretStore().backend).toBe('plaintext-unavailable');
  });
});
