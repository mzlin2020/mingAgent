import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryBlobStore } from '@xm/kernel';
import { PtySessionManager } from '@xm/tools-core';
import { productionTools } from '../src/main/production-tools.js';

describe('desktop production tool assembly', () => {
  it('contains no demo tools and exposes controlled PTY without raw write', () => {
    const manager = new PtySessionManager({
      os: 'linux',
      emit: () => undefined,
      spawnPty: () => { throw new Error('not used'); },
    });
    const names = productionTools({
      os: 'linux',
      index: {
        state: () => 'cold',
        refresh: () => Promise.resolve({ state: 'ready', indexed: 0, unchanged: 0, removed: 0, errors: [] }),
        searchText: () => [],
        searchSymbols: () => [],
        close: () => Promise.resolve(),
      },
      backgroundSignal: {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      tempDir: join(tmpdir(), 'xm-desktop-tools-test'),
      ptySessions: manager,
      updateTodos: () => Promise.resolve(),
      expandResults: {
        blobs: new MemoryBlobStore((data) =>
          Promise.resolve(createHash('sha256').update(data).digest('hex')),
        ),
        resolveRef: () => Promise.resolve(undefined),
      },
      editProposals: {
        save: () => Promise.resolve(),
        get: () => Promise.resolve(undefined),
        markApplied: () => Promise.resolve(),
      },
      explore: () => Promise.reject(new Error('not used')),
    }).map((tool) => tool.descriptor.name);
    expect(names.some((name) => name.startsWith('demo.'))).toBe(false);
    expect(names).toContain('todo.update');
    expect(names).toContain('search.text');
    expect(names).toContain('search.symbol');
    expect(names).toContain('search.indexed');
    expect(names).toContain('result.expand');
    expect(names).toContain('edit.preview');
    expect(names).toContain('edit.apply');
    expect(names).toContain('agent.explore');
    expect(names).toContain('shell.session.run');
    expect(names).not.toContain('shell.session.write');
  });
});
