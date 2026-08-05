# `@xm/desktop`

小明的 Electron 外壳：`main` / `preload` / `renderer` 三段。

**这是整个应用唯一同时认识 Electron 与业务的地方**——往下每一层都不认识 electron
（depcruise 强制），往上渲染层没有 Node 权限。

```bash
pnpm --filter @xm/desktop dev       # Vite + tsup watch + Electron
pnpm --filter @xm/desktop build     # 三段产物 + 存在性检查
pnpm --filter @xm/desktop package   # electron-builder --dir（不签名，M0-b）
```

## 结构

| 目录 | 内容 |
|---|---|
| `src/main/` | 装配（services）、IPC 处理器、启动自检、窗口与生命周期 |
| `src/preload/` | `contextBridge` 窄接口。**一根管子，不是一道闸门** |
| `src/renderer/` | React 19 + Tailwind 4 + Zustand。会话状态由 `reduce()` 算出 |
| `src/shared/` | IPC 通道名（`channels.ts`，纯常量）与 Zod 契约（`ipc.ts`） |

## 五条容易被破坏的约束

**一、三个隔离开关一起才叫隔离。**
`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，缺一个等于没开。
最容易被"为了方便"关掉的是 `sandbox`——关掉之后 preload 能拿到完整 Node，
而 preload 是页面唯一能间接触达的代码。

**二、preload 的表面积就是隔离的缺口大小。**
它只转发四个具名调用，不校验、不解析、不缓存、不聚合，也不 import zod 或 `@xm/*`
（depcruise 规则 `preload-必须保持薄`）。**不提供 `invoke(channel, args)` 这种通用入口**——
那等于把整个 IPC 表面暴露给页面，窄接口就只剩一个说法。

**三、IPC 载荷两边都校验，但理由不同。**
主进程那一侧是**安全**：渲染层将来要渲染模型输出、网页内容、插件 UI，
而主进程握着文件系统、数据库与权限闸门。渲染层那一侧是**版本一致性**：
开发时热重载会让两边错开，而"事件形状悄悄变了"的表现是 UI 静默少一块。

失败一律是返回值 `{ ok: false, code, message }`，不跨 IPC 抛异常——
Electron 会把异常序列化成一个丢了 `code` 的字符串，而 UI 要靠 `code` 说出
"改策略 / 重新审批 / 改系统权限"这三句不同的话。

**四、渲染层没有第二份状态。**
消息列表、运行中的工具、待审批的权限全由 `@xm/kernel` 的 `reduce()` 从事件流算出，
跟主进程用的是同一个纯函数。只要 UI 自己维护一份 `messages` 数组，
它就会和回放出来的那份慢慢分叉，表现是"刷新一下内容就变了"。

这同时是「内核能在浏览器里跑」的运行时证据——`reduce` 在这里跑在没有 Node 的渲染进程里。

**五、平台判断走 `PlatformPort.os`，主进程也不例外。**
`window-all-closed` 里那句"macOS 关窗不退出"是最容易破例的地方，
一句 `process.platform === 'darwin'` 看着无害，但破了例就没有下一道防线了（ADR-0007）。

## 启动自检拦的是什么

`assertStorageWorks()` 在建窗口**之前**跑：开一个 `:memory:` 库、写一条、读回来。

原本的说法是"防 Node 与 Electron 的 ABI 两轨"。2026-08-05 实测下来这个说法
**对 better-sqlite3 13 不成立**——它随包发的 `prebuilds/*.node` 是 N-API
（导出 `napi_register_module_v1`），Node 与 Electron 都能直接加载（ADR-0016）。

它真正拦的是**打包**：`files` 漏了 `prebuilds/`、`.node` 被打进 asar、数据目录不可写。
三样都表现为"窗口起来了、列表是空的、点什么都没反应"——看着像 UI bug，
实际是数据库根本没打开。自检把它变成一句说清了原因的错误框。

`electron-builder.yml` 里的 `asarUnpack` 就是为第二样准备的：
`.node` 走 `require()` 加载真实路径，而 asar 里的路径不是真实路径。

## 已知缺口

**没有在真机上启动过。** 本轮的开发环境缺 GUI 系统库（libatk / libgtk），
且没有安装它们的权限，所以 `electron .` 起不来。已经验证的是：三段产物能构建、
`electron-builder --dir` 能打包、`.node` 确实被 asarUnpack 出来了。

"能启动"这一格由 CI 的 `desktop` job 补：三平台各跑一次 `XM_SMOKE=1 electron .`，
Linux 上加 `xvfb-run`。它跑的是**打包产物**，与 `scripts/smoke-headless.mjs`
（Node、源码树）互补——后者看不见打包问题。需要有远端仓库后才能实跑。

## 相关文档

- [ADR-0015 进程与 IPC 边界](../../docs/adr/0015-进程与IPC边界.md)
- [ADR-0016 原生模块与打包](../../docs/adr/0016-原生模块与打包.md)
- [ADR-0004 主界面形态](../../docs/adr/0004-主界面形态.md)
- [docs/04 §2 进程模型](../../docs/04-总体架构.md)
