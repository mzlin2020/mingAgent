import { describe, expect, it } from 'vitest';
import { resolvePtyExecutable } from '@xm/tools-core';

describe('Windows PTY executable resolution', () => {
  it('resolves a bare command with PATH and PATHEXT before node-pty sees it', () => {
    const expected = 'C:\\Program Files\\nodejs\\node.EXE';
    const resolved = resolvePtyExecutable('node', {
      os: 'windows',
      cwd: 'C:\\work',
      env: { PATH: 'C:\\first;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE' },
      isFile: (candidate) => candidate === expected,
    });
    expect(resolved).toBe(expected);
  });

  it('checks the final PATH segment even without a trailing semicolon', () => {
    const expected = 'C:\\last\\tool.EXE';
    expect(resolvePtyExecutable('tool', {
      os: 'windows',
      cwd: 'C:\\work',
      env: { PATH: 'C:\\first;C:\\last', PATHEXT: '.EXE' },
      isFile: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it('leaves POSIX argv resolution to node-pty', () => {
    expect(resolvePtyExecutable('node', {
      os: 'linux',
      cwd: '/work',
      env: { PATH: '/bin' },
    })).toBe('node');
  });
});
