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

/**
 * 五个受控终端工具的规范输出值（ADR-0071）。
 *
 * 这一组是整批迁移里"散文最不够用"的：`shell.session.open` 成功时把新会话 id 拼在
 * 一句中文里（`终端会话已打开：<id>`），失败时把异常消息原样当结果——**程序想拿 id
 * 就只能去切那个冒号**。所以这里的 `ok` + `ptySessionId` 不是锦上添花，
 * 它是这组工具第一次真正能被串起来用。
 *
 * 四个查询/控制工具共用一份 schema：它们的结果本来就只有"成不成、哪个会话、附带什么"。
 * 只有 `open` 单独一份，因为它的 `ptySessionId` 是**产出**而不是入参。
 */
const OpenOutput = z.strictObject({
  ok: z.boolean(),
  /** 只在 ok 时出现 */
  ptySessionId: z.string().optional(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** 失败原因 */
  message: z.string().optional(),
});

const SessionOutput = z.strictObject({
  ok: z.boolean(),
  ptySessionId: z.string(),
  /** `status` 专有：终端当前状态 */
  state: z.enum(['idle', 'running', 'exited', 'timed_out', 'killed']).optional(),
  /** `status` 专有：命令已结束时的退出码 */
  exitCode: z.number().int().optional(),
  /** `status` 专有：有界的输出尾部 */
  tail: z.string().optional(),
  /** `run` 专有：已提交的命令 */
  argv: z.array(z.string()).optional(),
  /** `resize` 专有 */
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
  message: z.string().optional(),
});

/**
 * 两个具名构造器而不是一个收 `unknown` 的通用构造器。
 *
 * 理由很实在：规范值形状不对时 `parseOutput` 会**静默丢掉**它（失败关闭，见 ADR-0071），
 * 模型照常拿到文本、程序拿到 `undefined`，而且没有任何一处会报错。
 * 这类错误只能在编译期拦，所以别把类型放开成 `unknown`。
 */
const openResult = (text: string, output: z.infer<typeof OpenOutput>): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text } satisfies ResultBlock],
  output,
});

const sessionResult = (text: string, output: z.infer<typeof SessionOutput>): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text } satisfies ResultBlock],
  output,
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
    outputSchema: OpenOutput,
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      const base = { cwd: input.cwd, cols: input.cols, rows: input.rows };
      if (ctx.signal.aborted) {
        yield openResult('没有打开：本轮已经中断。', {
          ...base,
          ok: false,
          message: '本轮已经中断。',
        });
        return;
      }
      try {
        const id = manager.open({ xmSessionId: ctx.sessionId, ...input });
        yield openResult(`终端会话已打开：${id}`, { ...base, ok: true, ptySessionId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield openResult(`没能打开终端会话：${message}`, { ...base, ok: false, message });
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
    outputSchema: SessionOutput,
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      await manager.run(ctx.executor, ctx.sessionId, input.ptySessionId as PtySessionId, input);
      yield sessionResult('命令已启动；用 shell.session.status 查询状态和输出尾部。', {
        ok: true,
        ptySessionId: input.ptySessionId,
        argv: [...input.argv],
      });
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
    outputSchema: SessionOutput,
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      try {
        const status = manager.status(ctx.sessionId, input.ptySessionId as PtySessionId);
        yield sessionResult(JSON.stringify(status), {
          ok: true,
          ptySessionId: input.ptySessionId,
          ...status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield sessionResult(message, { ok: false, ptySessionId: input.ptySessionId, message });
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
    outputSchema: SessionOutput,
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      const base = { ptySessionId: input.ptySessionId, cols: input.cols, rows: input.rows };
      try {
        manager.resize(ctx.sessionId, input.ptySessionId as PtySessionId, input.cols, input.rows);
        yield sessionResult('已调整。', { ...base, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield sessionResult(message, { ...base, ok: false, message });
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
    outputSchema: SessionOutput,
    available,
    async *execute(input, ctx) {
      await Promise.resolve();
      try {
        manager.close(ctx.sessionId, input.ptySessionId as PtySessionId);
        yield sessionResult('已关闭。', { ok: true, ptySessionId: input.ptySessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield sessionResult(message, { ok: false, ptySessionId: input.ptySessionId, message });
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
