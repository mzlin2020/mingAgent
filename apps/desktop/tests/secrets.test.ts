import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError } from '@xm/kernel';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

const { keychainSecretStore } = await import('../src/main/secrets.js');
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-keychain-test-'));
  file = join(dir, 'secrets.json');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('desktop keychain SecretStore', () => {
  it('persists and reloads values without exposing plaintext', async () => {
    await keychainSecretStore({ file }).set({ $secret: 'provider.apiKey' }, 'secret-value');
    expect(await readFile(file, 'utf8')).not.toContain('secret-value');
    expect(await keychainSecretStore({ file }).get({ $secret: 'provider.apiKey' })).toBe('secret-value');
  });

  it('rejects corrupt and wrong-typed files and never overwrites them on set', async () => {
    await writeFile(file, '{broken');
    const store = keychainSecretStore({ file });
    await expect(store.get({ $secret: 'k' })).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(store.set({ $secret: 'k' }, 'value')).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(await readFile(file, 'utf8')).toBe('{broken');
    await writeFile(file, JSON.stringify({ k: 42 }));
    await expect(store.list()).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});
