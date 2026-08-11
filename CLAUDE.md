# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库文档、注释、提交信息**统一中文**（标识符 / 类型名 / 事件名用英文）。本文件也按此约定写。

## 项目是什么

**小明（xiaoming）** —— 跑在本地桌面的通用私人 Agent：能改代码、能操作电脑、最终能改进自己。
TypeScript 单语言 monorepo（pnpm workspace）+ Electron 外壳 + React 渲染层。
非目标：多租户 SaaS、无代码编排画布、自研模型。

当前阶段：**M1 已完成，处在 M1.5「上手打磨」**——条目由真实使用产生，不预先排清单（`docs/08`）。

## 常用命令

```bash
pnpm install        # 顺带断言双编译器工具链 + 安装 git hooks
pnpm verify         # 提交前的全量闸门，等价于 CI 的六个 job
pnpm test           # vitest run（测试直接吃 src/，改代码不用先 build）
pnpm lint           # eslint .
pnpm typecheck      # 注意是四次 tsc，见下
pnpm smoke          # 只跑 headless 冒烟（跑的是 dist/，先 tsc -b）

pnpm --filter @xm/desktop dev       # Vite + tsup watch + Electron（需要 GUI）
pnpm --filter @xm/desktop build     # main/preload/renderer 三段产物 + 存在性检查
pnpm --filter @xm/desktop package   # electron-builder --dir
```

跑单个测试：

```bash
pnpm exec vitest run packages/kernel/tests/policy-engine.test.ts
pnpm exec vitest run -t '注入降级'         # 按用例名过滤
pnpm exec vitest packages/kernel           # watch 某个包
```

**真实 Provider 验收**（`packages/providers/tests/live.test.ts`，默认整组跳过，CI 永不运行）：

```bash
XM_LIVE_PROVIDER=1 XM_LIVE_API_KEY=… \
XM_LIVE_ANTHROPIC_BASE=… XM_LIVE_OPENAI_BASE=… XM_LIVE_MODEL=… \
pnpm exec vitest run packages/providers/tests/live.test.ts
```

`pnpm typecheck` 是四次 `tsc`，缺一次就会漏掉一整片代码：
`tsc -b`（各包）、`tsconfig.tests.json`（测试）、`apps/desktop/tsconfig.main.json`、
`apps/desktop/tsconfig.renderer.json`（主进程与渲染层的 lib/types 完全不同，必须分开）。

单项闸门也可以单独跑：`pnpm depcruise`、`pnpm size`、`pnpm check:file-size`、
`pnpm check:paths`、`pnpm check:workflows`、`pnpm toolchain`。

## 架构：依赖方向是唯一的硬约束

```
Surfaces (apps/desktop, 未来 apps/cli)
   ↓ Session API（事件流订阅 + 命令下发）
Runtime  @xm/runtime      装配层：事件总线 · 唯一 seq 分配点 · Turn 循环 · 崩溃恢复
   ↓ Ports（纯接口，全部定义在 kernel/src/port/）
Kernel   @xm/kernel       纯逻辑 · 零 I/O · 零 node:* · 能在浏览器里跑
   ↑ Adapters 实现 Ports
platform · storage · providers · tools-core
```

**内核不知道任何适配器的存在。** 这条由 `.dependency-cruiser.cjs` 的 20 条规则强制，
不是靠自觉——改动依赖关系前先看那个文件，它比本节更权威。

| 包 | 职责 | 不许碰 |
|---|---|---|
| `contracts` | 唯一契约来源：事件/工具/权限/模型/配置的 Zod schema 与推导类型 | 除 zod 外任何依赖，包括其它 `@xm/*` |
| `kernel` | 状态归约 `reduce()`、权限判定 `evaluate()`、工具注册与截断、全部端口定义 | `node:*`、electron、任何 SDK；也不许依赖 `tools-core` |
| `platform` | `PlatformPort` 的 Node 实现：os 识别、路径、能力探测、配置加载、密钥后端 | electron |
| `storage` | SQLite 事件存储 + 文件 blob（`EventStore`/`BlobStore` 落地） | electron |
| `providers` | ModelProvider 各家实现，只用 Web 平台 API（fetch/AbortController/TextDecoder） | `node:*`、electron、DOM、localStorage |
| `tools-core` | fs 读写列举 · 路径能力网关 · shell.exec · PTY · web.fetch · 写前还原点 | electron、`@xm/runtime` |
| `runtime` | 把上面这些拼成可运行的 headless 引擎 | electron、`tools-core` |
| `apps/desktop` | Electron main/preload/renderer —— **整个应用唯一同时认识 Electron 与业务的地方** | — |

未开工的包**不建空目录**：空包会让 depcruise 规则指着一个不存在的目录空转（已吃过两次亏）。

## 几条最容易被无意破坏的不变量

**一、状态 = `reduce(events)`，不许有只写内存不写事件的状态。**
渲染层不维护第二份 `messages` 数组——它调用的是主进程用的同一个纯函数
（这同时是"内核能在浏览器里跑"的运行时证据）。流式渲染的例外边界见 ADR-0021。

**二、契约单一来源。** 跨进程/跨包的数据一律走 `@xm/contracts` 的 Zod schema，
两侧都校验，校验失败即抛出并记录，**不静默兜底**。禁止在渲染层手写事件类型或做
`normalizeEvent` 式手工转换。IPC 失败一律用返回值 `{ ok:false, code, message }`，
不跨 IPC 抛异常（Electron 会把异常序列化成丢了 `code` 的字符串）。

**三、模型输出、网页内容、文件内容、MCP 返回值都是不可信输入。**
所有工具入参 Zod `.strict()`；有副作用的工具必须声明 `capabilities` 与 `risk`；
任何绕过 deny 判定的路径都要有 ADR。红线按**目标是什么**写，不能按**调用方自称在做什么**写
（ADR-0017 的教训：自改红线只挂 `self.modify` 时，一个声明 `fs.write` 的普通写文件工具
就能整体绕过它——所以那 27 条同时挂在三个能力上）。

**四、权限判定只有两个答案：`allow` 与 `deny`（ADR-0039）。** `evaluate()` 三步：
target 规范化失败关闭(0) → 红线跨层最先判(1) → 分层求值，层内 deny 胜 allow(2) → 无匹配则放行(3)。
**没有"问用户"这条路径**：`ask` 已从 `PolicyVerdict` 删除（编译期护栏），
审批 UI、三档模式、注入降级、会话授权全部移除。
收紧的表达方式**只有一种**：往规则表里加 deny。想加一个"判完之后再修正一次"的后置步骤前，
先读 ADR-0039 的背景——ADR-0034/0035/0036 三次真实体验问题全出在那种形状上。

**五、判定看到的路径必须就是工具打开的那个路径。**
`tools-core/src/gateway.ts` 负责相对→绝对、`realpath.native`（解符号链接 + Windows 8.3 短名）、
**把解析后的路径回写进 `input`**、以及"声明了路径能力却没声明 `pathInputs` 就当场失败关闭"。
必须是 `.native`——JS 版的 `realpath` 解不了 8.3 短名，那正是 ADR-0018 的红线绕过。

**六、渲染层零 Node 权限。** `contextIsolation` / `nodeIntegration:false` / `sandbox` 三个开关缺一
等于没开；preload 只转发少数具名调用，**不提供 `invoke(channel, args)` 这种通用入口**
（depcruise 规则 `preload-必须保持薄` 盯着）。

**七、平台判断走 `PlatformPort.os`，主进程也不例外。** 一句 `process.platform === 'darwin'`
看着无害，但破了例就没有下一道防线（ADR-0007）。

**八、密钥只从 SecretStore 来。** 配置层刻意**不接环境变量**——接上就等于给了一条
"把 key 塞进 env"的合法路径，而 `shell.exec` 会把整个环境原样交给子进程。
配置分层：内置默认 < `${paths.config}/config.json` < `${cwd}/.xiaoming/config.json`；
`permission.rules` 走分层而非合并（ADR-0023）。ADR-0039 之后 `config.json` 的
`permission.rules` 是**唯一**的用户侧权限入口（`permission.tier` 已删），
项目层只能收紧（`tightenOnly`）——那个文件躺在别人的仓库里。

## 工作纪律

**决策必须留痕。** 影响接口、依赖、数据格式的决定都要写 ADR（`docs/adr/0000-模板.md`）：
一决策一文件、**只增不改**、编号连续、被推翻时新写一份标 `Supersedes` 并在旧文件标
`Superseded by`。**新增 ADR 必须同步更新 `docs/adr/README.md` 的索引表**（漏过一次）。

**文档与代码同批提交。** 接口变更未同步文档视为未完成。`docs/` 是给人和小明自己共同读的。

**规模纪律入 CI。** 单文件 > 400 行由 `scripts/check-file-size.mjs` 拦截（只扫 `packages/**` 与
`apps/desktop/src`，不扫 tests）。豁免必须写进脚本里的 `ALLOWLIST` 并附一句理由；
文件瘦回 400 行以内脚本会反过来报错提醒摘掉豁免。函数 > 60 行仍是人工审查项。

**改护栏必须做反向演练。** 本项目已经栽过八次"规则存在但从未生效"：depcruise 因未装
electron 而看不见 `import 'electron'`、因 exclude `dist/` 而看不见 135 条跨包边、
`trustLevel` 硬编码成 `'model'` 导致整套注入降级从未触发……
**加一条护栏后，必须先构造一个它真正要拦的场景、看它红一次**，只测纯函数对这类失效完全免疫。

**新增跨包 import 要同步 tsconfig paths。** 往 `apps/desktop` 里引入一个新的 `@xm/*` 时，
`tsconfig.main.json` / `tsconfig.renderer.json` 的 `paths` 都要加映射，否则类型解析静默退回
`dist/`——本地和大多数 CI job 都是绿的，只有"干净检出不 build"的 lint job 会红。
`pnpm check:paths` 就是为这个洞加的。

**双编译器不能混。** `tsc` 二进制必须是 TS 7（`@typescript/native`），JS 编译器 API 必须是
TS 6（供 typescript-eslint）。`pnpm toolchain` 是这条纪律唯一的自动化执行点（ADR-0010）。

**新依赖默认禁止跑安装脚本。** `pnpm-workspace.yaml` 的 `allowBuilds` 白名单越短越好；
显式拒绝写 `false` 而不是删掉，为的是留下"看过并决定了"的痕迹。

git pre-commit 钩子只做一件事：`scripts/check-secrets.mjs` 拦密钥（本地钩子要快，其余交给 CI）。

## 该读哪份文档

| 什么时候 | 读什么 |
|---|---|
| 做任何架构决策前 | `docs/01-愿景与设计原则.md`（七条原则 + 每条的可检验约束） |
| 写涉及契约的代码时 | `docs/10-契约设计.md`（实现级规格；与 `docs/04` 冲突时以 10 为准） |
| 涉及执行/网络/文件时 | `docs/06-安全与权限模型.md` + 相关 ADR |
| 排期 / 确认当前阶段 | `docs/08-路线图与里程碑.md` |
| 查某个决定为什么这么定 | `docs/adr/README.md` 索引表 —— 几乎每条反直觉的实现都有对应 ADR |
| 体验验收与复盘 | `docs/experience/` |
