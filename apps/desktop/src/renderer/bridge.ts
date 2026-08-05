import { z } from 'zod';
import {
  CreateSessionResult,
  IpcEnvelope,
  ListSessionsResult,
  PushedEvent,
  ReadSessionResult,
  SendUserMessageResult,
} from '../shared/ipc.js';

/**
 * 渲染层这一侧的 IPC 边界。
 *
 * 这里对主进程送来的东西**再 parse 一次**。收益不是安全（主进程比渲染层可信），
 * 是版本一致性：打包后两边理论上同版本，但开发时热重载会让它们错开，
 * 而"事件形状悄悄变了"的表现是 UI 静默少一块，最难查。
 *
 * 顺带，它把「契约包必须能在浏览器上下文里 import」从 depcruise 的静态承诺
 * 变成了运行时事实——这个文件跑在没有 Node 的渲染进程里。
 */

interface XmBridge {
  listSessions(): Promise<unknown>;
  createSession(req: unknown): Promise<unknown>;
  sendUserMessage(req: unknown): Promise<unknown>;
  readSession(req: unknown): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}

const bridge = (): XmBridge => {
  const w = window as unknown as { xm?: XmBridge };
  if (w.xm === undefined) {
    throw new Error(
      '找不到 window.xm：preload 没加载。检查 BrowserWindow 的 preload 路径与 sandbox 设置。',
    );
  }
  return w.xm;
};

export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

async function call<T extends z.ZodType>(promise: Promise<unknown>, schema: T): Promise<z.infer<T>> {
  const envelope = IpcEnvelope.safeParse(await promise);
  if (!envelope.success) {
    throw new IpcError('protocol_mismatch', `主进程返回的不是 IPC 信封：${envelope.error.message}`);
  }
  if (!envelope.data.ok) throw new IpcError(envelope.data.code, envelope.data.message);

  const payload = schema.safeParse(envelope.data.data);
  if (!payload.success) {
    throw new IpcError('protocol_mismatch', `载荷对不上契约：${payload.error.message}`);
  }
  return payload.data;
}

export const api = {
  listSessions: () => call(bridge().listSessions(), ListSessionsResult),
  createSession: (title?: string) =>
    call(bridge().createSession(title === undefined ? {} : { title }), CreateSessionResult),
  sendUserMessage: (sessionId: string, text: string) =>
    call(bridge().sendUserMessage({ sessionId, text }), SendUserMessageResult),
  readSession: (sessionId: string) =>
    call(bridge().readSession({ sessionId }), ReadSessionResult),

  /**
   * 事件推送。**解析不了的事件原样忽略并继续**，不让整条流断掉——
   * 未知事件类型是版本漂移的正常形态，不是错误（`EventEnvelope` 是 loose 的）。
   */
  onEvent: (listener: (event: PushedEvent) => void): (() => void) =>
    bridge().onEvent((raw) => {
      const parsed = PushedEvent.safeParse(raw);
      if (parsed.success) listener(parsed.data);
    }),
};
