# 小明 (xiaoming) · 通用私人 Agent — 文档索引

> 一个跑在本地桌面上、可长期演进的通用 Agent：既能改代码，也能操作电脑，最终能改进它自己。

## 一页速览

| 项 | 结论 |
|---|---|
| 产品形态 | 桌面应用，风格贴近 Claude Code 桌面端。Tier 1: Windows / macOS；Tier 2: Linux（除计算机操作外全功能）。CLI 形态 M3 补上 |
| 技术栈 | TypeScript **7.0** 单语言 monorepo（编译走 TS 7 原生、工具 API 走 TS 6，见 [ADR-0010](./adr/0010-TypeScript双编译器工具链.md)）+ Electron 外壳 + React 渲染层；热点可在后续引入 Rust sidecar |
| 架构范式 | 六边形架构（Ports & Adapters）+ 事件溯源；插件宿主是 M3 规划，尚未实现 |
| 内核定位 | `@xm/kernel` 纯逻辑、零 I/O、零 Node API，可在浏览器/Node/测试中运行 |
| 可插拔单元 | 模型提供商、工具、MCP Server、插件、执行器（本地/容器/远程）、技能(Skill) |
| 安全基线 | 默认不信任模型输出；策略判定只有 `allow` / `deny`，以红线与拒绝清单为核心（[ADR-0039](./adr/0039-放弃审批模式.md)） |
| 长期目标 | L4 级自我迭代（自动生成技能与插件、自动改进自身代码；判权与护栏代码始终受红线保护） |

## 文档结构

| 文档 | 内容 | 何时读 |
|---|---|---|
| [01-愿景与设计原则](./01-愿景与设计原则.md) | 做什么、不做什么、七条不可妥协的原则 | 每次做架构决策前 |
| [02-参考项目评审-manusAgent](./02-参考项目评审-manusAgent.md) | 取其精华、去其糟粕的逐条对照 | 复用参考实现前 |
| [03-技术选型](./03-技术选型.md) | Electron / Tauri / Python sidecar 三方案对比与结论 | 需要理解既有技术决策时 |
| [04-总体架构](./04-总体架构.md) | 已实现边界、进程模型、事件流与后续扩展位置 | 改动跨包边界或新增能力前 |
| [05-可插拔与扩展体系](./05-可插拔与扩展体系.md) | 六类扩展点的契约、生命周期、隔离与版本策略 | 设计任何新能力时 |
| [06-安全与权限模型](./06-安全与权限模型.md) | 威胁模型、拒绝规则、能力清单、密钥与审计 | 涉及执行/网络/文件时 |
| [07-自我迭代能力](./07-自我迭代能力.md) | L0–L4 分级、改进闭环、评测集、红线 | 规划长期能力时 |
| [08-路线图与里程碑](./08-路线图与里程碑.md) | M0–M6 的范围与验收标准 | 排期时 |
| [09-待讨论的开放问题](./09-待讨论的开放问题.md) | 尚未拍板的决策点与我的倾向 | 下一轮讨论 |
| [10-契约设计](./10-契约设计.md) | `@xm/contracts` 的实现级规格：事件 / 工具 / 权限 / 模型 / 配置 schema | 改动任何跨层契约前 |
| [experience/](./experience/README.md) | 各版本体验测试用例与体验报告归档（按里程碑分册） | 上手打磨 / 体验验收与复盘 |
| [adr/](./adr/) | 架构决策记录（一决策一文件，只增不改） | 决策落定后立刻写 |

## 代码现状（2026-08-11）

**M1 已完成，当前处于 M1.5「上手打磨」**。M1 已交付流式对话、真实 Provider、密钥归宿、
文件工具、命令与 PTY、网页抓取（含 SSRF 防护）、多模态图片、崩溃恢复、会话导航和自动命名；
M1.5 的条目只由真实使用反馈驱动，不预先排清单。当前进度与下一阶段以
[08-路线图与里程碑](./08-路线图与里程碑.md) 为准。

权限模型已在 2026-08-11 收敛为「红线 + 拒绝清单」：没有审批 UI、权限档位、会话授权或
`ask` 判定。规则未命中时默认放行；红线、内置拒绝规则和用户配置的 `deny` 仍会阻断操作。
详见 [ADR-0039](./adr/0039-放弃审批模式.md) 与 [06-安全与权限模型](./06-安全与权限模型.md)。

| 包 | 状态 |
|---|---|
| [`packages/contracts`](../packages/contracts/README.md) | 唯一契约来源：Zod schema、事件、工具、权限、模型与配置 |
| [`packages/kernel`](../packages/kernel/README.md) | 纯逻辑、零 I/O；全部端口在此定义 |
| [`packages/platform`](../packages/platform/README.md) | `PlatformPort` 的 Node 实现（[ADR-0014](./adr/0014-数据目录与平台路径.md)） |
| [`packages/storage`](../packages/storage/README.md) | SQLite 事件存储 + 文件 blob（[ADR-0013](./adr/0013-存储引擎选型与EventStore端口.md)） |
| [`packages/providers`](../packages/providers/) | Anthropic 与 OpenAI-compatible 的流式适配器 |
| [`packages/tools-core`](../packages/tools-core/) | 文件、命令、PTY、网页抓取与能力网关 |
| [`packages/runtime`](../packages/runtime/README.md) | 会话运行时、事件总线、Turn 循环、崩溃恢复与自动命名 |
| [`apps/desktop`](../apps/desktop/README.md) | Electron main/preload/renderer、窄 IPC 与 React 桌面界面 |

验证入口是 `pnpm verify`：它覆盖工具链、类型检查、lint、测试、headless 冒烟、
依赖方向与契约包体积。涉及架构护栏的改动，必须构造一次它应拦截的反向演练。

```bash
pnpm install     # 自动断言双编译器工具链装配正确
pnpm verify      # toolchain + typecheck + lint + test + headless 冒烟 + depcruise + size
pnpm smoke       # 只跑 headless 冒烟（跑的是 dist/，不是源码）
pnpm --filter @xm/desktop dev    # Electron + Vite
```

## 现行资料的优先级

实现与文档出现冲突时，按下面顺序判断：**已实现代码与测试** → **已采纳 ADR** →
[10-契约设计](./10-契约设计.md)（实现级契约）→ [04-总体架构](./04-总体架构.md)（全景）→
路线图与其它说明文档。特别是权限相关内容，以 ADR-0039 为准；不得从旧文档把 `ask`、
审批档位或会话授权重新带回实现。

## 文档约定

1. **决策必须留痕**。任何影响接口、依赖、数据格式的决定，写一份 ADR（模板见 `adr/0000-模板.md`），旧决策被推翻时新写一份并标注 `Supersedes`。
2. **文档与代码同批提交**。接口变更未同步文档，视为未完成。
3. **中文优先**。代码注释、日志、文档统一中文；标识符、类型名、事件名用英文。
4. **本目录是给人和 Agent 共同读的**。小明自己会读这些文档来理解自身架构，因此措辞要精确、避免含糊的形容词。
