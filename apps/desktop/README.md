# `@xm/desktop`

M1.5 新增只读“设置与安全”面板，使用与运行时分发相同的工具可用性计算，并明示当前是策略边界而非 OS 沙箱。生产工具统一由 `production-tools.ts` 装配，不注册 `demo.*`。Electron 主窗口拒绝 renderer 创建新窗口或导航到外部页面。

M2-a 新增可见任务清单：生产装配注册 `todo.update`，renderer 直接读取事件归约出的 `SessionState.todos` 展示进度；空清单不渲染面板，不维护第二份任务状态。

M2-b 的生产装配注册 `search.text` 与 `result.expand`；后者通过窄回调只解析当前会话 `tool.end.fullRef`，renderer 不获得 BlobStore 浏览能力。

M2-c 新增 checkpoint 列表、结构化详情与一次性撤销 IPC/UI；恢复的开始、失败和成功都写入会话事件，renderer 只消费 `reduce()` 得到的状态。

M2-d 的生产装配注册 `edit.preview` / `edit.apply`，通过窄事件回调保存和完成 `EditProposal`；headless 与桌面端共用同一提案事实来源。

M2-e 新增持久 diff 审阅面板：renderer 只展示事件投影中的 pending 提案，逐块选择通过窄 IPC 生成收窄提案，再复用生产 `edit.apply` 分发路径；拒绝全部不写盘，大 diff 单块最多挂载 400 行。

M2-g 在生产工具装配中注册 `search.symbol` / `search.indexed`，会话打开和创建后在后台触发同一工作区的增量刷新；索引不是启动前置条件，未就绪时工具自动退回 ripgrep。tree-sitter 只使用 WASM 资产，不改变三平台原生模块策略。

M2-i 在生产装配中注册 `agent.explore`，按 `config.model.subagent → model.main` 回落选择模型；子会话使用同一事件库的独立 session，启动时自动把未闭合派生补成 interrupted，renderer 仍只消费父会话归约状态。

小明的 Electron 外壳：`main` / `preload` / `renderer` 三段。

**这是整个应用唯一同时认识 Electron 与业务的地方**——往下每一层都不认识 electron
（depcruise 强制），往上渲染层没有 Node 权限。

```bash
pnpm --filter @xm/desktop dev       # Vite + tsup watch + Electron
pnpm --filter @xm/desktop build     # 三段产物 + 存在性检查
pnpm --filter @xm/desktop package   # electron-builder --dir（不签名）
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
它只转发显式列出的具名调用，不校验、不解析、不缓存、不聚合，也不 import zod 或 `@xm/*`
（depcruise 规则 `preload-必须保持薄`）。**不提供 `invoke(channel, args)` 这种通用入口**——
那等于把整个 IPC 表面暴露给页面，窄接口就只剩一个说法。

**三、IPC 载荷两边都校验，但理由不同。**
主进程那一侧是**安全**：渲染层将来要渲染模型输出、网页内容、插件 UI，
而主进程握着文件系统、数据库与权限闸门。渲染层那一侧是**版本一致性**：
开发时热重载会让两边错开，而"事件形状悄悄变了"的表现是 UI 静默少一块。

失败一律是返回值 `{ ok: false, code, message }`，不跨 IPC 抛异常——
Electron 会把异常序列化成一个丢了 `code` 的字符串，而 UI 要靠 `code` 区分
“策略拒绝 / 输入或状态错误 / 系统能力不可用”等不同处置。

**四、渲染层没有第二份状态。**
消息列表、运行中的工具、todo、编辑提案、checkpoint 与不可信状态全由 `@xm/kernel` 的
`reduce()` 从事件流算出，
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

## 当前构建边界

截至 2026-08-13，renderer/main/preload 三段生产构建均通过，`pnpm verify` 与 M2 同链路 dist
smoke 也已通过。`electron-builder --dir` 在本机解压 Electron 后遇到 Windows 对
`win-unpacked.tmp/resources/default_app.asar` 的外部文件锁，失败发生在应用文件打包前；因此
本轮不宣称产出了可分发安装目录。详情见 [M2 体验报告](../../docs/experience/m2/体验报告.md)。

`XM_SMOKE=1 electron .` 的桌面启动检查与 `scripts/smoke-headless.mjs` 互补：前者发现窗口、preload
和打包问题，后者验证纯 Node 的发布产物与完整 Agent 链路。

## 相关文档

- [ADR-0015 进程与 IPC 边界](../../docs/adr/0015-进程与IPC边界.md)
- [ADR-0016 原生模块与打包](../../docs/adr/0016-原生模块与打包.md)
- [ADR-0004 主界面形态](../../docs/adr/0004-主界面形态.md)
- [docs/04 §2 进程模型](../../docs/04-总体架构.md)
