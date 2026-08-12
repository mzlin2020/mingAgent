import { describe, expect, it } from 'vitest';
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
      ptySessions: manager,
      updateTodos: () => Promise.resolve(),
    }).map((tool) => tool.descriptor.name);
    expect(names.some((name) => name.startsWith('demo.'))).toBe(false);
    expect(names).toContain('todo.update');
    expect(names).toContain('shell.session.run');
    expect(names).not.toContain('shell.session.write');
  });
});
