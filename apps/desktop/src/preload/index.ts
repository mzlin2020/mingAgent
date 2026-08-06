import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/channels.js';

/**
 * preload —— **一根管子，不是一道闸门**（ADR-0015）。
 *
 * 它只做两件事：把十个具名调用转发给主进程，把主进程推来的事件转发给页面。
 * 不校验、不解析、不缓存、不聚合。
 *
 * 为什么刻意这么薄：preload 跑在页面与主进程之间，是 `contextIsolation` 唯一的缺口。
 * 缺口的大小等于这个文件的表面积。一个"顺手"在这里做的缓存或转换，就是一个页面脚本
 * 可以间接影响主进程状态的地方。
 *
 * 也因此它不 import zod、不 import `@xm/*`（depcruise 规则 `preload 只许依赖 electron
 * 与 shared/channels` 盯着这条）。校验在两端各自做：主进程不信任渲染层送上来的东西，
 * 渲染层不信任主进程送下来的形状。
 *
 * 暴露的接口只有十个，且都是具名的——**不提供 `invoke(channel, args)` 这种通用入口**。
 * 通用入口等于把整个 IPC 表面暴露给页面，那时窄接口就只是个说法。
 */
contextBridge.exposeInMainWorld('xm', {
  listSessions: () => ipcRenderer.invoke(CH.listSessions),
  createSession: (req: unknown) => ipcRenderer.invoke(CH.createSession, req),
  sendUserMessage: (req: unknown) => ipcRenderer.invoke(CH.sendUserMessage, req),
  readSession: (req: unknown) => ipcRenderer.invoke(CH.readSession, req),
  clearUntrusted: (req: unknown) => ipcRenderer.invoke(CH.clearUntrusted, req),
  interrupt: (req: unknown) => ipcRenderer.invoke(CH.interrupt, req),
  respondPermission: (req: unknown) => ipcRenderer.invoke(CH.respondPermission, req),
  chooseWorkspace: () => ipcRenderer.invoke(CH.chooseWorkspace),
  status: () => ipcRenderer.invoke(CH.status),
  setApiKey: (req: unknown) => ipcRenderer.invoke(CH.setApiKey, req),

  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(CH.event, handler);
    return () => {
      ipcRenderer.off(CH.event, handler);
    };
  },
});
