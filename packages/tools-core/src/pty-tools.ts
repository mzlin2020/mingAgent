import { z } from 'zod';
import type { PtySessionId, ResultBlock, ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import {
  SHELL_SESSION_CLOSE,
  SHELL_SESSION_OPEN,
  SHELL_SESSION_RESIZE,
  SHELL_SESSION_RUN,
  SHELL_SESSION_STATUS,
  PtySessionManager,
} from './pty-session.js';

const OpenInput = z.strictObject({
  cwd: z.string().min(1),
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
});

const RunInput = z.strictObject({
  ptySessionId: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const SessionInput = z.strictObject({ ptySessionId: z.string().min(1) });
const ResizeInput = SessionInput.extend({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const textResult = (text: string): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text } satisfies ResultBlock],
});

const available = (ctx: {
  readonly platform: { readonly shellSession: boolean };
  readonly executor: { readonly capabilities: { readonly pty: boolean } };
}): boolean => ctx.platform.shellSession && ctx.executor.capabilities.pty;

export const shellSessionOpenTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_OPEN,
    group: 'shell',
    description: '打开受控终端会话。会话不提供原始 stdin；使用 shell.session.run 提交 argv 命令。',
    inputSchema: OpenInput,
    risk: 'high',
    capabilities: ['shell.session'],
    concurrency: 'exclusive',
    pathInputs: ['cwd'],
    resources: () => [{ kind: 'global', name: 'shell-session-open' }],
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      if (ctx.signal.aborted) {
        yield textResult('没有打开：本轮已经中断。');
        return;
      }
      try {
        const id = manager.open({ xmSessionId: ctx.sessionId, ...input });
        yield textResult(`终端会话已打开：${id}`);
      } catch (error) {
        yield textResult(`没能打开终端会话：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

export const shellSessionRunTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_RUN,
    group: 'shell',
    description: '在受控终端中直接运行 argv；不经过 shell，不支持 REPL、vim 或全屏交互。',
    inputSchema: RunInput,
    risk: 'medium',
    capabilities: ['shell.exec'],
    concurrency: 'exclusive',
    commandInputs: {
      argv: 'argv',
      cwd: 'cwd',
      resolveCwd: (input, ctx) => {
        const parsed = RunInput.parse(input);
        return manager.cwd(ctx.sessionId, parsed.ptySessionId as PtySessionId);
      },
    },
    resources: (input) => [
      { kind: 'pty', sessionId: input.ptySessionId },
      { kind: 'path', mode: 'write', glob: input.cwd ?? '.' },
    ],
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      await manager.run(ctx.executor, ctx.sessionId, input.ptySessionId as PtySessionId, input);
      yield textResult('命令已启动；用 shell.session.status 查询状态和输出尾部。');
    },
  });

export const shellSessionStatusTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_STATUS,
    group: 'shell',
    description: '只读查询受控终端的运行状态、退出码和有界输出尾部。',
    inputSchema: SessionInput,
    risk: 'safe',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      try {
        yield textResult(JSON.stringify(manager.status(ctx.sessionId, input.ptySessionId as PtySessionId)));
      } catch (error) {
        yield textResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

export const shellSessionResizeTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_RESIZE,
    group: 'shell',
    description: '调整受控终端窗口尺寸。',
    inputSchema: ResizeInput,
    risk: 'safe',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      try {
        manager.resize(ctx.sessionId, input.ptySessionId as PtySessionId, input.cols, input.rows);
        yield textResult('已调整。');
      } catch (error) {
        yield textResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

export const shellSessionCloseTool = (manager: PtySessionManager): RegisteredTool =>
  defineTool({
    name: SHELL_SESSION_CLOSE,
    group: 'shell',
    description: '关闭受控终端并终止其中仍在运行的进程树。',
    inputSchema: SessionInput,
    risk: 'safe',
    capabilities: [],
    resources: (input) => [{ kind: 'pty', sessionId: input.ptySessionId }],
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      try {
        manager.close(ctx.sessionId, input.ptySessionId as PtySessionId);
        yield textResult('已关闭。');
      } catch (error) {
        yield textResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

export const shellSessionTools = (manager: PtySessionManager): readonly RegisteredTool[] => [
  shellSessionOpenTool(manager),
  shellSessionRunTool(manager),
  shellSessionStatusTool(manager),
  shellSessionResizeTool(manager),
  shellSessionCloseTool(manager),
];
