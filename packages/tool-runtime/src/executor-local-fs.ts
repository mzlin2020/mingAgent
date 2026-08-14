import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpath as realpathCallback } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionFileSystem, ExecutionStat } from '@xm/kernel';

const statOf = async (path: string): Promise<ExecutionStat> => {
  const value = await stat(path);
  return {
    size: value.size,
    file: value.isFile(),
    directory: value.isDirectory(),
    symbolicLink: value.isSymbolicLink(),
  };
};

const writeTextAtomic = async (path: string, content: string): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.xm-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const localExecutionFileSystem = (): ExecutionFileSystem => ({
  stat: statOf,
  realpath: promisify(realpathCallback.native),
  read: (path) => readFile(path),
  async *readChunks(path, chunkBytes = 64 * 1024) {
    for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
      yield chunk as Uint8Array;
    }
  },
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      file: entry.isFile(),
      directory: entry.isDirectory(),
      symbolicLink: entry.isSymbolicLink(),
    }));
  },
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  mkdtemp,
  remove: (path, options = {}) => rm(path, options),
  writeTextAtomic,
  sha256: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  path: { dirname, join, relative, resolve, isAbsolute },
});
