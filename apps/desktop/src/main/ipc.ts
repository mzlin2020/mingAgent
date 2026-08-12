import { dialog, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { z } from 'zod';
import { CH } from '../shared/channels.js';
import {
  AbandonOrphanedSessionRequest,
  ClearUntrustedRequest,
  CreateSessionRequest,
  InterruptRequest,
  ReadBlobRequest,
  ReadSessionRequest,
  ResumeOrphanedSessionRequest,
  SendUserMessageRequest,
  SetApiKeyRequest,
} from '../shared/ipc.js';
import type { Services } from './services.js';

/**
 * IPC 处理器（ADR-0015）。
 *
 * 两条不许破的规矩：
 *
 * **一、入参一律先 parse。** 渲染层送上来的东西是不可信的——它将来要渲染模型输出、
 * 网页内容、插件 UI，而主进程这一侧握着文件系统、数据库与权限闸门。
 * `contextIsolation` 挡的是"页面直接拿到 Node"，挡不住"页面调用我们自己开的这几个接口"。
 *
 * **二、异常不直接扔过 IPC。** Electron 会把它序列化成一个丢了类型、丢了 code、
 * 只剩字符串的东西，UI 拿它没法给出正确的下一步引导。所以失败也是一个正常返回值
 * （`{ ok: false, code, message }`）——contracts 里区分 policy_denied / user_rejected /
 * permission_denied，就是为了 UI 能说出"改策略 / 解除不可信标记 / 改系统权限"这三句不同的话。
 */
export function registerIpc(services: Services, windows: () => BrowserWindow[]): void {
  handle(CH.listSessions, undefined, async () => services.listSessions());

  handle(CH.createSession, CreateSessionRequest, async (req) => ({
    sessionId: await services.createSession({
      ...(req.title === undefined ? {} : { title: req.title }),
      ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
    }),
  }));

  handle(CH.sendUserMessage, SendUserMessageRequest, async (req) => ({
    reason: await services.sendUserMessage(req.sessionId, req.text, req.images),
  }));

  handle(CH.readBlob, ReadBlobRequest, async (req) => ({
    dataUrl: await services.readBlob(req.ref),
  }));

  handle(CH.readSession, ReadSessionRequest, async (req) => {
    return services.getSessionState(req.sessionId);
  });

  handle(CH.clearUntrusted, ClearUntrustedRequest, async (req) => ({
    cleared: await services.clearUntrusted(req.sessionId, req.reason),
  }));

  handle(CH.interrupt, InterruptRequest, (req) =>
    // 同步执行、立刻返回：停止这条路径上不该有任何 await（见 services.interrupt 的注释）
    Promise.resolve({ interrupted: services.interrupt(req.sessionId) }),
  );

  /*
   * 崩溃恢复（M1-e，docs/04 §8）。列表在启动时已经扫描好、缓存在主进程内存里；
   * 继续/放弃这两个处理器把请求转给 services.ts，那里会重新在 runtime.state 上
   * 判一遍，不信任这份扫描时的旧缓存。
   */
  handle(CH.listOrphanedSessions, undefined, () => Promise.resolve(services.listOrphanedSessions()));

  handle(CH.resumeOrphanedSession, ResumeOrphanedSessionRequest, async (req) => ({
    resolved: await services.resumeOrphanedSession(req.sessionId),
  }));

  handle(CH.abandonOrphanedSession, AbandonOrphanedSessionRequest, async (req) => ({
    resolved: await services.abandonOrphanedSession(req.sessionId),
  }));

  /*
   * 选工作目录。**路径由主进程的原生对话框产生。**
   *
   * 渲染层送一个字符串上来在权限上是等价的（判定看的是网关解析出的绝对路径），
   * 但"这个目录是用户自己选的"这件事只有原生对话框能保证——而工作目录决定了
   * 模型给的相对路径落在哪，这个前提值得用一次系统对话框换。
   */
  handle(CH.chooseWorkspace, undefined, async () => {
    const win = windows()[0];
    const result = await (win === undefined
      ? dialog.showOpenDialog({ properties: ['openDirectory'] })
      : dialog.showOpenDialog(win, { properties: ['openDirectory'] }));
    const picked = result.filePaths[0];
    return picked === undefined || result.canceled ? {} : { path: picked };
  });

  handle(CH.status, undefined, async () => {
    const s = await services.status();
    return {
      providerReady: s.providerReady,
      providerId: s.providerId,
      model: s.model,
      secretBackend: s.secretBackend,
      hasApiKey: s.hasApiKey,
      configProblems: s.configProblems.map((p) => ({ code: p.code, message: p.message })),
      security: s.security,
    };
  });

  /*
   * 录入密钥。**这个处理器不返回任何与 key 有关的东西**——连"存进去的是什么"都不回显。
   * 失败时走统一的 IpcFailure，而那条路径上的 message 来自 SecretUnavailableError，
   * 它讲的是后端为什么不可用，里面没有密钥。
   */
  handle(CH.setApiKey, SetApiKeyRequest, async (req) => {
    await services.setApiKey(req.providerId, req.key);
    return { ok: true as const };
  });

  /*
   * 事件推送。**订阅在总线上，不在存储上**（ADR-0013 不变量五）：
   * 存储不做发布订阅，追加成功之后由 runtime 发出来，这里只是把它转给窗口。
   *
   * 窗口没了就别发——`isDestroyed()` 之后 `send` 会抛，而那个异常会顺着
   * `publish` 冒到追加路径上。总线本身吞订阅者的异常，这里再挡一道是因为
   * "窗口关闭"是常态而不是异常。
   */
  services.bus.subscribe((event) => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.event, event);
    }
  });
}

function handle<S extends z.ZodType | undefined>(
  channel: string,
  schema: S,
  run: (input: S extends z.ZodType ? z.infer<S> : undefined) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    let input: unknown;
    if (schema === undefined) {
      input = undefined;
    } else {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false as const,
          code: 'invalid_input',
          message: `IPC 入参不合法：${parsed.error.issues.map((i) => i.message).join('；')}`,
        };
      }
      input = parsed.data;
    }

    try {
      return { ok: true as const, data: await run(input as never) };
    } catch (e) {
      return {
        ok: false as const,
        code: e instanceof Error ? e.name : 'internal',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });
}
