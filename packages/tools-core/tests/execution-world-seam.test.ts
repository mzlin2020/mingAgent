import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newSessionId, type EditProposal, type PtySessionId } from '@xm/contracts';
import type {
  ExecutionDirectoryEntry,
  ExecutionFileSystem,
  ExecutionProcessInput,
  ExecutionPtyInput,
  ExecutionPtyProcess,
  ExecutionWorld,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';
import {
  PtySessionManager,
  coreTools,
  editApplyTool,
  editPreviewTool,
  shellSessionTools,
  type EditProposalAccess,
} from '@xm/tools-core';

const NEVER = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

interface RecordingWorld {
  readonly world: ExecutionWorld;
  readonly calls: string[];
  readonly files: Map<string, Uint8Array>;
}

const recordedWorld = (): RecordingWorld => {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>([
    ['/w/a.txt', Buffer.from('alpha\n')],
    ['/w/edit.txt', Buffer.from('old\n')],
  ]);
  const list = (): readonly ExecutionDirectoryEntry[] => [
    { name: 'a.txt', file: true, directory: false, symbolicLink: false },
  ];
  const processRun = (input: ExecutionProcessInput) => {
    calls.push(`process.run:${input.argv.join(' ')}`);
    let stdout = '';
    if (input.argv[0] === 'rg') {
      stdout = `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/w/a.txt' }, lines: { text: 'alpha\n' },
          line_number: 1, submatches: [{ start: 0 }],
        },
      })}\n`;
    } else if (input.argv[0] === 'git' && input.argv[1] === 'status') {
      stdout = '## main\n';
    } else if (input.argv.includes('--name-status')) {
      stdout = 'M\tedit.txt\n';
    }
    input.onStdout?.(stdout);
    return Promise.resolve({
      stdout, stderr: '', code: 0, signal: undefined,
      timedOut: false, interrupted: false, clipped: false, stoppedByConsumer: false,
    });
  };
  const pty: ExecutionPtyProcess = {
    onData: () => undefined,
    onExit: () => undefined,
    resize: vi.fn(),
    kill: vi.fn(),
  };
  const world: ExecutionWorld = {
    kind: 'local',
    capabilities: { filesystem: true, process: true, pty: true },
    fs: {
      stat(path) {
        calls.push(`fs.stat:${path}`);
        return Promise.resolve({
          size: files.get(path)?.byteLength ?? 0,
          file: path !== '/w', directory: path === '/w', symbolicLink: false,
        });
      },
      realpath(path) {
        calls.push(`fs.realpath:${path}`);
        return Promise.resolve(path);
      },
      read(path) {
        calls.push(`fs.read:${path}`);
        return Promise.resolve(files.get(path) ?? new Uint8Array());
      },
      async *readChunks(path) {
        await Promise.resolve();
        calls.push(`fs.readChunks:${path}`);
        yield files.get(path) ?? new Uint8Array();
      },
      list(path) { calls.push(`fs.list:${path}`); return Promise.resolve(list()); },
      mkdir(path) { calls.push(`fs.mkdir:${path}`); return Promise.resolve(); },
      mkdtemp(prefix) { calls.push(`fs.mkdtemp:${prefix}`); return Promise.resolve(`${prefix}fake`); },
      remove(path) { calls.push(`fs.remove:${path}`); return Promise.resolve(); },
      writeTextAtomic(path, content) {
        calls.push(`fs.writeTextAtomic:${path}`);
        files.set(path, Buffer.from(content));
        return Promise.resolve();
      },
      sha256(bytes) {
        calls.push('fs.sha256');
        return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
      },
      path: {
        dirname: (path) => posix.dirname(path),
        join: (...parts) => posix.join(...parts),
        relative: (from, to) => posix.relative(from, to),
        resolve: (...parts) => posix.resolve(...parts),
        isAbsolute: (path) => posix.isAbsolute(path),
      },
    },
    process: { run: processRun },
    pty: {
      spawn(input: ExecutionPtyInput) {
        calls.push(`pty.spawn:${input.argv.join(' ')}`);
        return Promise.resolve(pty);
      },
    },
  };
  return { world, calls, files };
};

const contextOf = (executor: ExecutionWorld, sessionId = newSessionId()): ToolContext => ({
  sessionId, cwd: '/w', executor, signal: NEVER,
});

const drain = async (tool: RegisteredTool, input: unknown, ctx: ToolContext): Promise<string> => {
  let text = '';
  for await (const progress of tool.execute(input, ctx)) {
    if (progress.kind === 'result' && progress.forModel[0]?.type === 'text') {
      text = progress.forModel[0].text;
    }
  }
  return text;
};

describe('M3-e ExecutionWorld 接缝', () => {
  it('全部 fs/process 业务工具跟随记录型 provider，且路径原样交付', async () => {
    const recording = recordedWorld();
    const ctx = contextOf(recording.world);
    const tools = new Map(
      coreTools({ os: 'linux', tempDir: '/tmp/tools' })
        .filter((tool) => tool.descriptor.name !== 'web.fetch')
        .map((tool) => [tool.descriptor.name, tool]),
    );
    const inputs: Readonly<Record<string, unknown>> = {
      'fs.read': { path: '/w/a.txt' },
      'fs.list': { path: '/w' },
      'fs.write': { path: '/w/new.txt', content: 'new' },
      'search.text': { pattern: 'alpha', path: '/w', maxResults: 10 },
      'shell.exec': { argv: ['echo', 'ok'], cwd: '/w' },
      'git.status': {},
      'git.diff': { argv: ['git', 'diff', '--no-ext-diff', '--no-textconv', '--no-color'] },
      'git.branch': { argv: ['git', 'switch', '-c', 'topic'] },
      'git.commit': { argv: ['git', 'commit', '--only', '-m', 'msg', '--', 'edit.txt'] },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`缺少工具 ${name}`);
      await drain(tool, input, ctx);
    }
    expect(recording.calls).toContain('fs.stat:/w/a.txt');
    expect(recording.calls).toContain('fs.list:/w');
    expect(recording.calls).toContain('fs.writeTextAtomic:/w/new.txt');
    expect(recording.calls.some((call) => call.startsWith('process.run:rg '))).toBe(true);
    expect(recording.calls.some((call) => call === 'process.run:echo ok')).toBe(true);
    expect(recording.calls.filter((call) => call.startsWith('process.run:git ')).length).toBeGreaterThan(4);
    expect(recording.calls.some((call) => call.startsWith('fs.realpath:'))).toBe(false);
  });

  it('provider 无法用返回值替换已经过网关的路径', () => {
    type ReadResult = Awaited<ReturnType<ExecutionFileSystem['read']>>;
    const acceptReadResult = (value: ReadResult): ReadResult => value;
    expect(acceptReadResult(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
    // @ts-expect-error read 只返回字节；provider 没有回传另一条 path 的结构入口。
    acceptReadResult({ path: '/elsewhere', bytes: new Uint8Array([1]) });
  });

  it('edit preview/apply 只经 provider 读写与散列', async () => {
    const recording = recordedWorld();
    const ctx = contextOf(recording.world);
    let proposal: EditProposal | undefined;
    let applied = false;
    const access: EditProposalAccess = {
      save: (_sessionId, value) => { proposal = value; return Promise.resolve(); },
      get: () => Promise.resolve(proposal === undefined ? undefined : { proposal, applied }),
      markApplied: () => { applied = true; return Promise.resolve(); },
    };
    await drain(editPreviewTool(access), {
      files: [{
        path: '/w/edit.txt',
        replacements: [{ oldText: 'old', newText: 'new', expectedMatches: 1 }],
      }],
    }, ctx);
    if (proposal === undefined) throw new Error('未生成提案');
    await drain(editApplyTool(access), {
      proposalId: proposal.proposalId,
      files: proposal.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
    }, ctx);
    expect(applied).toBe(true);
    expect(new TextDecoder().decode(recording.files.get('/w/edit.txt'))).toBe('new\n');
    expect(recording.calls).toContain('fs.read:/w/edit.txt');
    expect(recording.calls).toContain('fs.writeTextAtomic:/w/edit.txt');
  });

  it('全部 PTY 工具共享同一个 provider，不存在本地旁路', async () => {
    const recording = recordedWorld();
    const sessionId = newSessionId();
    const ctx = contextOf(recording.world, sessionId);
    const manager = new PtySessionManager({ os: 'linux', emit: () => undefined });
    const tools = new Map(shellSessionTools(manager).map((tool) => [tool.descriptor.name, tool]));
    const opened = await drain(tools.get('shell.session.open')!, { cwd: '/w' }, ctx);
    const ptySessionId = opened.split('：').at(-1) as PtySessionId;
    await drain(tools.get('shell.session.run')!, { ptySessionId, argv: ['node', '--version'] }, ctx);
    await drain(tools.get('shell.session.status')!, { ptySessionId }, ctx);
    await drain(tools.get('shell.session.resize')!, { ptySessionId, cols: 100, rows: 30 }, ctx);
    await drain(tools.get('shell.session.close')!, { ptySessionId }, ctx);
    expect(recording.calls).toContain('pty.spawn:node --version');
  });
});
