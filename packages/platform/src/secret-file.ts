import { randomBytes, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretRef } from '@xm/contracts';
import type { SecretBackend, SecretStore } from '@xm/kernel';
import { SecretUnavailableError } from '@xm/kernel';

/**
 * 口令加密文件后端 —— 没有钥匙串时的兜底（`SecretBackend = 'encrypted-file'`）。
 *
 * 走到这条路的典型场景：无桌面会话的 Linux、容器、CI、以及 Wayland 上某些
 * 没装 keyring 的发行版。`platform.ts` 的注释已经写明这三态**不是 boolean**，
 * 就是为了让这一档能被明确表达而不是退化成"没有密钥功能"。
 *
 * ── 密码学选择 ──
 *
 * scrypt 派生 + AES-256-GCM。都是 `node:crypto` 自带的，不引任何依赖。
 * GCM 而不是 CBC：认证加密，密文被改动会在解密时报错而不是解出垃圾——
 * 一个"解出垃圾 key 然后拿去请求"的路径会产生极难排查的 401。
 *
 * **每个条目独立的 salt 与 iv。** 共用会让两个相同的密钥产生相同的密文，
 * 从而泄漏"这两个 provider 用的是同一个 key"。
 *
 * ⚠️ 这一档的安全性**取决于口令**，不取决于这段代码。文件落在用户目录里，
 * 拿到文件的人可以离线爆破。所以 UI 必须说清楚它比钥匙串弱在哪，
 * 而不是显示一个绿色的"已加密"就完事。
 */

interface Entry {
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

type FileShape = Record<string, Entry>;

const SCRYPT_KEYLEN = 32;
/** N=2^15。比默认高一档：这份文件是可以被离线爆破的，成本要往上抬 */
const SCRYPT_COST = 32_768;
/**
 * `maxmem` 必须一起抬，否则 N 抬了也没用 —— 而失败的形态是**运行期抛异常**。
 *
 * scrypt 的内存开销是 `128 · N · r`，r 默认 8，于是 N=32768 要 33.5 MB，
 * 而 Node 的默认上限恰好是 32 MB。差这 1.5 MB，`set()` 在真实环境里会直接抛
 * `memory limit exceeded`——参数看着更安全，实际是一条存不进密钥的路径。
 * 第一条用例就把它照出来了。
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface FileSecretStoreOptions {
  /** 密文文件路径，通常是 `${paths.config}/secrets.json` */
  readonly file: string;
  /** 用户口令。**不落盘、不进日志** */
  readonly passphrase: string;
}

export function fileSecretStore(options: FileSecretStoreOptions): SecretStore {
  const backend: SecretBackend = 'encrypted-file';

  const read = async (): Promise<FileShape> => {
    try {
      const raw = await readFile(options.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isFileShape(parsed)) throw new Error('顶层或密文条目类型不合法');
      return parsed;
    } catch (e) {
      if (isNotFound(e)) return {};
      throw new SecretUnavailableError(
        backend,
        `密钥文件 ${options.file} 无法读取或已损坏，已保留原文件：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const write = async (shape: FileShape): Promise<void> => {
    await mkdir(dirname(options.file), { recursive: true });
    // 写临时文件 → rename，与 FileBlobStore 同一个手法：中途断电不会留下半个文件
    const tmp = `${options.file}.${String(process.pid)}-${String(Date.now())}.tmp`;
    await writeFile(tmp, JSON.stringify(shape, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(tmp, options.file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  };

  return {
    backend,

    async get(ref: SecretRef): Promise<string | undefined> {
      const entry = (await read())[ref.$secret];
      if (entry === undefined) return undefined;
      try {
        return await decrypt(entry, options.passphrase);
      } catch {
        /*
         * 解不开有两种可能：口令错了，或密文被改过。两种都不该静默返回 undefined——
         * 那会让上层以为"没配置过"，然后弹一个录入框，用户重新输入一遍，
         * 覆盖掉那条其实还在的密钥。
         */
        throw new SecretUnavailableError(
          backend,
          `无法解密密钥 "${ref.$secret}"：口令不对，或密文文件已损坏。`,
        );
      }
    },

    async set(ref: SecretRef, value: string): Promise<void> {
      const shape = await read();
      await write({ ...shape, [ref.$secret]: await encrypt(value, options.passphrase) });
    },

    async delete(ref: SecretRef): Promise<void> {
      const shape = await read();
      if (!(ref.$secret in shape)) return;
      const next: FileShape = {};
      for (const [k, v] of Object.entries(shape)) if (k !== ref.$secret) next[k] = v;
      await write(next);
    },

    async list(): Promise<readonly string[]> {
      return Object.keys(await read()).sort();
    },
  };
}

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isFileShape = (value: unknown): value is FileShape =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      ['salt', 'iv', 'tag', 'data'].every(
        (key) => key in entry && typeof (entry as Record<string, unknown>)[key] === 'string',
      ),
  );

// ── 加解密 ──────────────────────────────────────────────────────

const derive = (passphrase: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

async function encrypt(plaintext: string, passphrase: string): Promise<Entry> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derive(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

async function decrypt(entry: Entry, passphrase: string): Promise<string> {
  const key = await derive(passphrase, Buffer.from(entry.salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 口令校验用的哨兵条目。
 *
 * 没有它，第一次输错口令要等到"用这个 key 去请求被 401"才发现，而那时的报错
 * 指向的是 Provider 而不是口令。存一条已知明文，开箱就能验。
 */
export const PASSPHRASE_SENTINEL = '__xm.sentinel';
const SENTINEL_VALUE = 'xiaoming';

export async function verifyPassphrase(store: SecretStore): Promise<boolean> {
  const ref: SecretRef = { $secret: PASSPHRASE_SENTINEL };
  let current: string | undefined;
  try {
    current = await store.get(ref);
  } catch {
    return false;
  }
  if (current === undefined) {
    // 首次使用：把哨兵写进去，此后每次启动都能验
    await store.set(ref, SENTINEL_VALUE);
    return true;
  }
  const a = Buffer.from(current);
  const b = Buffer.from(SENTINEL_VALUE);
  return a.length === b.length && timingSafeEqual(a, b);
}
