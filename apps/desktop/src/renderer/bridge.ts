import { z } from 'zod';
import type { BlobRef } from '@xm/contracts';
import {
  ChooseWorkspaceResult,
  ClearUntrustedResult,
  CreateSessionResult,
  ImageAttachment,
  InterruptResult,
  IpcEnvelope,
  ListSessionsResult,
  PushedEvent,
  ReadBlobResult,
  ReadSessionResult,
  RespondPermissionResult,
  SendUserMessageResult,
  SetApiKeyResult,
  StatusResult,
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
  readBlob(req: unknown): Promise<unknown>;
  clearUntrusted(req: unknown): Promise<unknown>;
  interrupt(req: unknown): Promise<unknown>;
  respondPermission(req: unknown): Promise<unknown>;
  chooseWorkspace(): Promise<unknown>;
  status(): Promise<unknown>;
  setApiKey(req: unknown): Promise<unknown>;
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
  createSession: (options: { title?: string; cwd?: string } = {}) =>
    call(
      bridge().createSession({
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      }),
      CreateSessionResult,
    ),
  sendUserMessage: (sessionId: string, text: string, images?: readonly ImageAttachment[]) =>
    call(
      bridge().sendUserMessage({
        sessionId,
        text,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
      }),
      SendUserMessageResult,
    ),
  readSession: (sessionId: string) =>
    call(bridge().readSession({ sessionId }), ReadSessionResult),
  readBlob: (ref: BlobRef) => call(bridge().readBlob({ ref }), ReadBlobResult),

  clearUntrusted: (sessionId: string, reason?: string) =>
    call(
      bridge().clearUntrusted(reason === undefined ? { sessionId } : { sessionId, reason }),
      ClearUntrustedResult,
    ),

  interrupt: (sessionId: string) => call(bridge().interrupt({ sessionId }), InterruptResult),

  respondPermission: (
    sessionId: string,
    requestId: string,
    effect: 'allow' | 'deny',
    scope: 'once' | 'session' | 'always',
  ) =>
    call(
      bridge().respondPermission({ sessionId, requestId, effect, scope }),
      RespondPermissionResult,
    ),

  /** 打开原生目录选择框。用户取消时返回 `{}` */
  chooseWorkspace: () => call(bridge().chooseWorkspace(), ChooseWorkspaceResult),

  status: () => call(bridge().status(), StatusResult),

  /** 录入密钥。**注意没有对应的读取方法**——渲染层永远拿不到密钥的值 */
  setApiKey: (providerId: string, key: string) =>
    call(bridge().setApiKey({ providerId, key }), SetApiKeyResult),

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
