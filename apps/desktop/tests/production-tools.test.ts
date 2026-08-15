import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryBlobStore } from '@xm/kernel';
import { openProductionTools } from '../src/main/production-tools.js';

describe('desktop production tool assembly', () => {
  it('contains no demo tools and exposes controlled PTY without raw write', async () => {
    const host = await openProductionTools({
      os: 'linux',
      index: {
        state: () => 'cold',
        stats: () => ({ roots: [] }),
        refresh: () => Promise.resolve({ state: 'ready', indexed: 0, unchanged: 0, removed: 0, errors: [] }),
        clear: () => Promise.resolve(),
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
      emitPty: () => undefined,
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
        markReviewed: () => Promise.resolve(),
      },
      explore: () => Promise.reject(new Error('not used')),
    });
    const names = host.tools.map((tool) => tool.descriptor.name);
    expect(host.available).toBe(true);
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
    host.dispose();
  });
});
