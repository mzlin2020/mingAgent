# 小明 (xiaoming) · 通用私人 Agent — 文档索引

> 一个跑在本地桌面上、可长期演进的通用 Agent：既能改代码，也能操作电脑，最终能改进它自己。

## 一页速览

| 项 | 结论 |
|---|---|
| 产品形态 | 桌面应用，风格贴近 Claude Code 桌面端。Tier 1: Windows / macOS；Tier 2: Linux（除计算机操作外全功能）。CLI 形态 M3 补上 |
| 技术栈 | TypeScript **7.0** 单语言 monorepo（编译走 TS 7 原生、工具 API 走 TS 6，见 [ADR-0010](./adr/0010-TypeScript双编译器工具链.md)）+ Electron 外壳 + React 渲染层，热点用 Rust sidecar |
| 架构范式 | 六边形架构（Ports & Adapters）+ 事件溯源 + 进程外插件宿主 |
| 内核定位 | `@xm/kernel` 纯逻辑、零 I/O、零 Node API，可在浏览器/Node/测试中运行 |
| 可插拔单元 | 模型提供商、工具、MCP Server、插件、执行器（本地/容器/远程）、技能(Skill) |
| 安全基线 | 默认不信任模型输出；四道闸门 Policy → Consent → Sandbox → Audit |
| 长期目标 | L4 级自我迭代（自动生成技能与插件、自动改进自身代码，核心变更需人工闸门） |

## 文档结构

| 文档 | 内容 | 何时读 |
|---|---|---|
| [01-愿景与设计原则](./01-愿景与设计原则.md) | 做什么、不做什么、七条不可妥协的原则 | 每次做架构决策前 |
| [02-参考项目评审-manusAgent](./02-参考项目评审-manusAgent.md) | 取其精华、去其糟粕的逐条对照 | 复用参考实现前 |
| [03-技术选型](./03-技术选型.md) | Electron / Tauri / Python sidecar 三方案对比与结论 | 现在（待拍板） |
| [04-总体架构](./04-总体架构.md) | 分层、包结构、核心接口、数据流、并发与持久化 | 写第一行代码前 |
| [05-可插拔与扩展体系](./05-可插拔与扩展体系.md) | 六类扩展点的契约、生命周期、隔离与版本策略 | 设计任何新能力时 |
| [06-安全与权限模型](./06-安全与权限模型.md) | 威胁模型、四道闸门、能力清单、密钥与审计 | 涉及执行/网络/文件时 |
| [07-自我迭代能力](./07-自我迭代能力.md) | L0–L4 分级、改进闭环、评测集、红线 | 规划长期能力时 |
| [08-路线图与里程碑](./08-路线图与里程碑.md) | M0–M6 的范围与验收标准 | 排期时 |
| [09-待讨论的开放问题](./09-待讨论的开放问题.md) | 尚未拍板的决策点与我的倾向 | 下一轮讨论 |
| [10-契约设计](./10-契约设计.md) | `@xm/contracts` 的实现级规格：事件 / 工具 / 权限 / 模型 / 配置 schema | **写 M0 第一行代码时** |
| [adr/](./adr/) | 架构决策记录（一决策一文件，只增不改） | 决策落定后立刻写 |

## 代码现状（2026-08-05）

**M0 已完成**（M0-a 契约与内核、M0-b 外壳与持久化），欠一项：应用没在真机上启动过，
本轮开发环境缺 GUI 系统库且无安装权限，该格由 CI 的 `desktop` job 补，前提是有远端仓库。

| 包 | 状态 |
|---|---|
| [`packages/contracts`](../packages/contracts/README.md) | 唯一契约来源，零依赖 6.75 kB |
| [`packages/kernel`](../packages/kernel/README.md) | 纯逻辑、零 I/O；全部端口在此定义 |
| [`packages/platform`](../packages/platform/README.md) | `PlatformPort` 的 Node 实现（[ADR-0014](./adr/0014-数据目录与平台路径.md)） |
| [`packages/storage`](../packages/storage/README.md) | SQLite 事件存储 + 文件 blob（[ADR-0013](./adr/0013-存储引擎选型与EventStore端口.md)） |
| [`packages/runtime`](../packages/runtime/README.md) | 装配层 + headless 冒烟 |
| [`apps/desktop`](../apps/desktop/README.md) | Electron 三段（[ADR-0015](./adr/0015-进程与IPC边界.md)、[ADR-0016](./adr/0016-原生模块与打包.md)） |

314 个测试、依赖图 127 模块 380 条边零违规、契约包 6.78 kB（预算 15 kB）。

```bash
pnpm install     # 自动断言双编译器工具链装配正确
pnpm verify      # toolchain + typecheck + lint + test + headless 冒烟 + depcruise + size
pnpm smoke       # 只跑 headless 冒烟（跑的是 dist/，不是源码）
pnpm --filter @xm/desktop dev    # Electron + Vite
```

> **本轮反复出现的一件事**：M0-b 里发现了**三条从写下起就没生效过的护栏**——
> depcruise 因 electron 未安装而看不见 `import 'electron'`、因 `dist/` 被 exclude 而看不见
> 全部跨包 `@xm/*` 边（135 条）、以及 docs/06 §7 写了一个里程碑却根本不存在的审计红线。
> 加上 M0-a 的 `includeOnly`，这是同一类失效的第四、五、六次。
> **「规则存在 ≠ 规则生效」不是一句口号，是这个项目每次动护栏都要做反向演练的原因。**
>
> **第七、八次紧接着就来了**（[ADR-0017](./adr/0017-地基复审二-注入防御与红线能力错位.md)，M0 交付后的地基复审）：
> `trustLevel` 全局硬编码成 `'model'`，导致整套提示词注入降级与三条 `red.*-untrusted`
> 红线**从未触发过**；九条自改红线只挂在 `self.modify` 上，一个声明 `fs.write` 的
> 普通写文件工具就能整体绕过。两处都是"判定逻辑完备、单元测试全绿、防御不存在"。
> 教训升级为一条可复用的规则：**红线要按"目标是什么"写，不能按"调用方自称在做什么"写**；
> 以及**护栏必须在它真正要拦的那条路径上被验证一次**，只测纯函数对这类失效完全免疫。

## 文档约定

1. **决策必须留痕**。任何影响接口、依赖、数据格式的决定，写一份 ADR（模板见 `adr/0000-模板.md`），旧决策被推翻时新写一份并标注 `Supersedes`。
2. **文档与代码同批提交**。接口变更未同步文档，视为未完成。
3. **中文优先**。代码注释、日志、文档统一中文；标识符、类型名、事件名用英文。
4. **本目录是给人和 Agent 共同读的**。小明自己会读这些文档来理解自身架构，因此措辞要精确、避免含糊的形容词。
