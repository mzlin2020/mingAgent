import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretRef } from '@xm/contracts';
import type { SecretStore } from '@xm/kernel';
import { SecretUnavailableError } from '@xm/kernel';

/**
 * 钥匙串后端（`SecretBackend = 'keychain'`）。
 *
 * ── 为什么用 Electron 的 `safeStorage` 而不是原生模块 ──
 *
 * `keytar` 已归档，其余 keyring 绑定都是需要本机编译的原生模块。引一个进来就要重开
 * ADR-0016 刚合上的那笔账（"N-API 预编译产物，Electron 升级不需要重编"）。
 * `safeStorage` 走的是 Electron 自己已经链好的那套：macOS Keychain、
 * Windows DPAPI、Linux libsecret——**同一组后端，零新增原生依赖**。
 *
 * 代价是密文要我们自己存。`safeStorage.encryptString()` 返回的是一段与本机
 * （在 macOS 上是与本应用）绑定的密文，落在 `${paths.config}/secrets.json` 里。
 * 拷到另一台机器上解不开——这正是我们要的性质。
 */

export interface KeychainSecretStoreOptions {
  /** 密文文件路径，通常是 `${paths.config}/secrets.json` */
  readonly file: string;
}

type FileShape = Record<string, string>;

export function keychainSecretStore(options: KeychainSecretStoreOptions): SecretStore {
  const read = async (): Promise<FileShape> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as FileShape) : {};
    } catch {
      return {};
    }
  };

  const write = async (shape: FileShape): Promise<void> => {
    await mkdir(dirname(options.file), { recursive: true });
    const tmp = `${options.file}.tmp`;
    await writeFile(tmp, JSON.stringify(shape, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, options.file);
  };

  /**
   * **每次调用都重新问一遍 `isEncryptionAvailable()`。**
   *
   * 启动时问过一次还不够：Linux 上 keyring 守护进程可以在应用运行期间挂掉，
   * 那之后 `encryptString` 会抛。缓存住启动时的答案，就会在这种时候
   * 把一个异常变成"看起来存上了"。
   */
  const assertAvailable = (): void => {
    if (safeStorage.isEncryptionAvailable()) return;
    throw new SecretUnavailableError(
      'keychain',
      '系统钥匙串当前不可用（可能是 keyring 服务已停止）。密钥没有被保存——不会退化成明文。',
    );
  };

  return {
    backend: 'keychain',

    async get(ref: SecretRef): Promise<string | undefined> {
      const cipher = (await read())[ref.$secret];
      if (cipher === undefined) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
      } catch {
        // 换过机器、或系统密钥变了。**不返回 undefined**——那会让上层以为"没配置过"
        // 然后弹录入框覆盖掉它。说清楚是解不开，让用户决定重录还是排查。
        throw new SecretUnavailableError(
          'keychain',
          `无法解密密钥 "${ref.$secret}"：密文可能来自另一台机器或另一个用户账户。`,
        );
      }
    },

    async set(ref: SecretRef, value: string): Promise<void> {
      assertAvailable();
      const cipher = safeStorage.encryptString(value).toString('base64');
      await write({ ...(await read()), [ref.$secret]: cipher });
    },

    async delete(ref: SecretRef): Promise<void> {
      const shape = await read();
      if (!(ref.$secret in shape)) return;
      const next: FileShape = {};
      for (const [k, v] of Object.entries(shape)) if (k !== ref.$secret) next[k] = v;
      await write(next);
    },

    /** 只有条目名。端口注释的第一条：**永远不返回值** */
    async list(): Promise<readonly string[]> {
      return Object.keys(await read()).sort();
    },
  };
}
