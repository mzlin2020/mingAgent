# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库文档、注释、提交信息**统一中文**（标识符 / 类型名 / 事件名用英文）。本文件也按此约定写。

## 项目是什么

**小明（xiaoming）** —— 跑在本地桌面的通用私人 Agent：能改代码、能操作电脑、最终能改进自己。
TypeScript 单语言 monorepo（pnpm workspace）+ Electron 外壳 + React 渲染层。
非目标：多租户 SaaS、无代码编排画布、自研模型。

当前阶段：**M2 与 M3 均已完成**。M2 的留痕见 `docs/experience/m2/收官记录.md`；
M3「微内核化重构」是 2026-08-14 新增的里程碑，原 M3–M6 顺延为 M4–M7；规划见 `docs/11-微内核与插件容器.md` 与 `docs/M3-阶段划分.md`，
决策见 ADR-0052 ~ 0072（其中 0062–0066 是 2026-08-14 规划复审的产物，
复审结论见 `docs/11 §10`）。**M3-a～M3-h 已全部完成并通过全量门禁，M3 收官**：
`@xm/kernel/src/container/`、确定性 `clock` / `ids`、`@xm/compose` profile 装配和
`@xm/tool-runtime` 已存在，desktop/headless 共用装配器；Turn 命名扩展点、工具十二步链、
执行收据、Agent 句柄、持久注入与 `ctx.executor` local 执行世界已落地；业务工具整包零
`node:*`，物理删除 `tools-core` 后仍能通过 typecheck 与空工具 headless 冒烟。
渲染层只认识四种卡片种类（M3-f）；`ext.persisted` / `ext.transient` 两个信封、
运行时不变量注册表与四张生成表进 `pnpm verify`（M3-g）。
证据逐段见 `docs/experience/m3/`。**M3.5「桌面端界面与设置」已收官**（2026-08-16 插段，
性质同 M1.5）：设计语言从暖色 Claude Code 调性换到冷调中性 + 三层 token、
两栏让位链、工具调用压成单行，以及**把配置中心从 M4 前移**。
**M3.5-a / M3.5-b / M3.5-c / M3.5-d / M3.5-e / M3.5-f 已落地**（ADR-0073 / 0074 / 0077 / 0075 / 0076；c、d、f 段无新 ADR）。
**M3.5 收官**。`config.json` 现为 14 个字段（`logging.*` 已删），桌面端可改叶子 10 个，含
`tools.presentation` 与 `permission.rules`。占用环是发送键旁 14px 投影，不进事件流。
规划见 `docs/12-桌面端界面与设置.md`
与 `docs/M3.5-阶段划分.md`，决策 ADR-0073～0077 已全部写完。
**M4 之前插了一轮全量复审（地基复审四，2026-08-17）**，开出 16 项、已修 8 项：
A1/A2/A3（自改红线的锚点与清单、拆不开的命令，ADR-0078/0079）与
B1/B2/C1/C2/D1（项目层配置的锚点、`pinnedHosts` 的键、入参 JSON 的静默兜底、
Code Mode 的运行域、工具并发调度，ADR-0080~0082）。两份修复记录在
`docs/experience/复审四/`，其中**第二份的开头那条判据值得单独读**：
一个契约做完的标志不是"接口和实现都在"，是"有一条测试跑过从调用方到效果的整条路"。
剩下 8 项（C3/C4/D2/D4、长期运行三条、功能缺口）列在同一份记录末尾。
**再往后才是 M4「能扩展」**：
三方插件隔离（`docs/09` H1）、MCP 与污点传播（G2）、Skill、多 Provider 角色路由、`xm` CLI 产品化。
后续里程碑仍必须按阶段逐段交付，每段独立可用、可测试，不跨阶段堆半成品。

**Code Mode 已落地（M3-h）**，三份 ADR 各管一段，改它之前三份都要读：

- **跑在哪**：QuickJS-WASM 客体域 + worker（ADR-0069）。`docs/09` 里那条旧倾向
  （独立子进程 + Node permission model）**被实测否掉**——`node --permission` 挡得住 `fs`
  与 `child_process`，却让 `fetch` 拿到 HTTP 200：Node 的权限模型没有网络这一档。
  别照那条倾向补代码。客体域自带 `Date` / `Math.random`，宿主**必须**覆盖它们；
  interrupt handler 是 CPU 预算，**另外必须有宿主侧墙钟**（去掉它，一次永不返回的绑定
  调用就能永远挂住）。断言在 `packages/code-runtime/tests/`。
- **拿到什么形状**：各工具的 `outputSchema`（ADR-0071，**不进描述符**）。写新工具时必须给它；
  在任何"包一层别的工具"的地方**必须显式翻译内层的规范值**——形状不符会被静默丢掉，
  程序拿到 `undefined` 且日志无痕。闸门在 `pnpm generate:docs --check`。
- **子调用怎么记**：**只落一条 `tool.code.dispatch`，不落 `tool.start` / `tool.end`**
  （ADR-0072）。那条 payload 里**没有 `forModel` 字段**，程序的中间值因此结构性地进不了
  模型请求——而"中间值不进提示词"是 Code Mode 省往返的前提，不是优化项。
  想给它加一个 `forModel`"让审计更完整"之前，先读 ADR-0072 §一：审计一条没少，
  少的只有"模型看到了什么"，而那本来就没发生过。
  判定两条路共用同一份 `dispatchCallWith()`，记录面参数化在 `CallSink` 上；
  `ctx.codeMode` 是**再入口不是权限**（每次子调用从头判）。
  呈现模式默认 `native`——**Code Mode 是 opt-in**，由 `tools.presentation` 切换。

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

`pnpm typecheck` 通常是四次 `tsc`，缺一次就会漏掉一整片代码：
`tsc -b`（各包）、`tsconfig.tests.json`（测试）、`apps/desktop/tsconfig.main.json`、
`apps/desktop/tsconfig.renderer.json`（主进程与渲染层的 lib/types 完全不同，必须分开）。
当 `packages/tools-core` 物理缺席时，同一入口改用 `tsconfig.no-tools.json`，跳过只属于该可选包的
测试工程，但仍检查其余包与 desktop main/renderer。

单项闸门也可以单独跑：`pnpm depcruise`、`pnpm size`、`pnpm check:file-size`、
`pnpm check:paths`、`pnpm check:workflows`、`pnpm toolchain`、`pnpm check:invariants`、
`pnpm check:redlines`（ADR-0078：自改红线的每条 glob 必须在仓库里匹配到真实文件——
一次重命名就能让红线安静地保护一个不存在的路径，而别的闸门全都不会红）。
M3 起新增 `pnpm check:determinism`：冻结 M0–M2 留下的时间/ID 直调，禁止数量继续增长；
M3-b 已迁移到 `ctx.clock` / `ctx.ids`，清单为零。profile 接缝图用 `pnpm generate:seams` 更新，
另外四张自省表（事件生产消费、扩展点挂载、工具目录、配置目录）用 `pnpm generate:docs` 更新；
`pnpm verify` 会检查它们是否漂移。M3-g 起还有 `pnpm check:invariants`：
拒收缺伴生模块、无理由的空 installer、以及断言"某某存在"的伪不变量。

`pnpm scan:invariants`（**诊断，不在 `verify` 里**）离线扫已有会话库：不变量只跑在写入
路径上，历史库里已经存在的违例要靠它查。加 `--data <目录>` / `--session <id>` 缩范围。

## 架构：依赖方向是唯一的硬约束

```
Surfaces (apps/desktop, 未来 apps/cli)
   ↓ 组合根 @xm/compose      profile 解析 · patch 合并 · 基线断言 · 容器装配
   ↓ Session API（事件流订阅 + 命令下发）
Runtime  @xm/runtime      装配层：事件总线 · 唯一 seq 分配点 · Turn 驱动器 + 命名扩展点 · 崩溃恢复
   ↓ Ports（纯接口，全部定义在 kernel/src/port/）
Kernel   @xm/kernel       纯逻辑 · 零 I/O · 零 node:* · 能在浏览器里跑（含插件容器 container/）
   ↑ Adapters 实现 Ports
platform · storage · providers · tool-runtime · tools-core · code-runtime
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
| `tool-runtime` | 路径/命令/主机网关 · 写前 checkpoint 与恢复 | electron |
| `tools-core` | fs 读写列举 · shell.exec · PTY · web.fetch 等业务工具 | electron、`@xm/runtime`、`@xm/tool-runtime` |
| `code-runtime` | Code Mode 的隔离提供者：QuickJS 客体域 + worker · TS 剥类型 · 预算 | electron；**kernel/runtime/storage/platform 反过来也不许认识它** |
| `runtime` | 把上面这些拼成可运行的 headless 引擎 | electron、`tools-core` |
| `compose` | 内建 profile · 用户 patch · 基线断言 · 容器装配 | electron；除 apps 外不得依赖它 |
| `apps/desktop` | Electron main/preload/renderer —— **整个应用唯一同时认识 Electron 与业务的地方** | — |

未开工的包**不建空目录**：空包会让 depcruise 规则指着一个不存在的目录空转（已吃过两次亏）。

**M3-a/M3-b 已在这张图上加两层、改两处**（见 `docs/04 §1.1`）：
容器进入 `kernel/src/container/`；`@xm/compose` 负责 profile 与装配；`@xm/tool-runtime`
承接路径网关、checkpoint 和 local 执行世界。M3-c 已把 `turn.ts` 收敛为驱动器 + 命名扩展点，
M3-d 已接入 Agent Inbox，M3-e 已让所有 fs/process/pty 工具只经 `ctx.executor` 执行，
M3-f 让渲染层只认识四种卡片种类、不再认识任何工具，
M3-h 新增 `@xm/code-runtime`（Code Mode 的隔离提供者，与 `tools-core` 一样装配层可以不装）。
**依赖方向的硬约束一字不改**，
且**不为插件新建细粒度包**——容器化会让一部分依赖关系从 import 图挪到运行时，
保住包边界规则是这个真损失的首要对策。

`tool-runtime` 那次拆分不是为了好看：网关是**能力的裁判**、工具是**能力**，
两者同包会让"删掉 `tools-core` 仍能启动"（原则二唯一的可检验约束）永远不可能成立。
顺带把"工具不得直接碰 `node:*`"从包内文件名单升级成包边界规则——名单会漏，边界不会。

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
就能整体绕过它——所以那 31 条受保护路径同时挂在三个能力上）。
**红线还有两个同样会静默失效的前提**（ADR-0078，地基复审四）：清单要**指着真实文件**
（M3 搬家后三条指向已删除文件，`pnpm check:redlines` 现在盯着），
锚点要**锚在真的那棵源码树上**（曾取 `app.getAppPath()` = 入口目录，
于是整族红线在任何真实运行方式下都不命中）。改 `SELF_MODIFY_PROTECTED` 前先读 ADR-0078。

**四、权限判定只有两个答案：`allow` 与 `deny`（ADR-0039）。** `evaluate()` 三步：
target 规范化失败关闭(0) → 红线跨层最先判(1) → 分层求值，层内 deny 胜 allow(2) → 无匹配则放行(3)。
**没有"问用户"这条路径**：`ask` 已从 `PolicyVerdict` 删除（编译期护栏），
审批 UI、三档模式、注入降级、会话授权全部移除。
收紧的表达方式**只有一种**：往规则表里加 deny。想加一个"判完之后再修正一次"的后置步骤前，
先读 ADR-0039 的背景——ADR-0034/0035/0036 三次真实体验问题全出在那种形状上。
⚠️ 删掉 `ask` 有一处连带后果直到 2026-08-17 才被发现：**"无规则匹配"从"问一次"变成了"放行"**，
于是 ADR-0026 那句"漏一条命令画像只是退回 ask"实际变成了"漏一条就是绕过全部路径红线"
（`python3 -c` / `sed -i` 实测可改判权代码）。处置见 ADR-0079。
**判定语义变了之后，要回头重算所有依赖旧语义的推理，编译器不会替你算。**

**五、判定看到的路径必须就是工具打开的那个路径。**
`tool-runtime/src/gateway.ts`（M3-a 从 `tools-core` 搬来）负责相对→绝对、
`realpath.native`（解符号链接 + Windows 8.3 短名）、
**把解析后的路径回写进 `input`**、以及"声明了路径能力却没声明 `pathInputs` 就当场失败关闭"。
必须是 `.native`——JS 版的 `realpath` 解不了 8.3 短名，那正是 ADR-0018 的红线绕过。

**六、渲染层零 Node 权限。** `contextIsolation` / `nodeIntegration:false` / `sandbox` 三个开关缺一
等于没开；preload 只转发少数具名调用，**不提供 `invoke(channel, args)` 这种通用入口**
（depcruise 规则 `preload-必须保持薄` 盯着）。

**七、平台判断走 `PlatformPort.os`，主进程也不例外。** 一句 `process.platform === 'darwin'`
看着无害，但破了例就没有下一道防线（ADR-0007）。

**八点五、模型可见 ⟺ 已落库（M3 起）。** 任何进入模型请求的东西，必须能从会话事件流重建。
这是不变量一在异步场景下的落点：`Agent.inject()` 必须落一条 `context.injected` 持久事件，
否则重开会话后模型看到的历史与注入前不一致，而**这种不一致是静默的**——不报错，
只让模型续跑时莫名其妙忘掉一件事（ADR-0056）。

**八点六、扩展点只能收紧（M3 起）。** 任何 waterfall 监听器都不能把 `deny` 变回 `allow`；
红线判定是单调 `guard`，后续监听器**在接口上就拿不到翻案入口**。六项安全底座
（seq 分配、`evaluate()`、路径网关、`SecretStore`、`redact()`、落库顺序）不可替换、
不可卸载、不可重排，由容器在装配收敛时断言在位。
**小明是「微内核 + 不可绕过的安全底座」，不是参考实现 deepseek-harness 的「一切可从配置替换」**
——照着那个仓库补代码前先读 ADR-0053，尤其别把它的 `ask` 判定搬回来（ADR-0039 已删）。

**八、密钥只从 SecretStore 来。** 配置层刻意**不接环境变量**——接上就等于给了一条
"把 key 塞进 env"的合法路径，而 `shell.exec` 会把整个环境原样交给子进程。
配置加载器支持：内置默认 < `${paths.config}/config.json` < 项目层 `.xiaoming/config.json`。
**分层从 ADR-0080 起分成两半**：`permission.rules` 的项目层**按会话工作目录**加载
（`loadProjectPermissionRules(cwd)` + 桌面端 `session-policy.ts`，按会话缓存），
其余字段按进程（启动时 `loadConfig({ paths })`，**不传 cwd**）——所以在
`.xiaoming/config.json` 里写 `model` 不生效。这条是修出来的：装配以前传
`cwd: app.getPath('home')`，于是**项目层从未生效过一次**，而 platform 的用例全绿，
因为它们自己把 cwd 传对了（地基复审四 B1）。
`permission.rules` 走分层而非合并（ADR-0023）。ADR-0039 之后 `config.json` 的
`permission.rules` 是**唯一**的用户侧权限入口（`permission.tier` 已删），
项目层只能收紧（`tightenOnly`）——那个文件躺在别人的仓库里。

**九、工具调用不再一定是串行的（ADR-0082）。** 一次回复里的多个调用切成顺序执行的批次、
批内并发（上限 8），入选条件是 `concurrency: 'parallel'` **且**资源声明里没有
write / global / pty。后果有两个：同批的 `tool.start`/`tool.end` **会交错**（每一对仍然配对，
但别再假定嵌套）；工具定义里的 `concurrency` / `resources()` 从此**有真实后果**——
声明成 parallel 却会写文件的工具会被并发调度。ADR-0005 想要的路径冲突检测做不到，
理由是 `resources(input)` 拿到的是网关规范化**之前**的入参。

**十、Code Mode 的子调用受两条取消信号管（ADR-0081）。** `terminate()` 只杀得掉客体域；
一段被墙钟掐掉的程序派发出去的 `shell.exec` 是宿主上的普通 Promise。所以
`CodeRuntime.call(request, signal)` 的第二个参数是**这一次 run 的运行域**，
接缝把它与 `deps.signal` 取并集接到 `ToolContext.signal` 上。写别的 `CodeRuntime`
实现时这条必须照做，否则"模型看到的"与"机器上发生的"会静默分叉。

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

**别把验收标准换成更容易通过的那条。** 2026-08-14 的 M3 规划复审抓到一次：原则二
"删掉 `packages/tools-core` 仍能启动"在 DoD 里变成了"删掉全部业务插件行仍能启动"——
**删行不等于删包**，规则还在，只是检验它的那个测试被换掉了。这比写错更难自查，
因为改完的文档读起来是自洽的。同一形状的还有"或…（优先做不到）""待定""倾向"
出现在一份标着 🟢 Accepted 的 ADR 里——**那说明决策没做完**。
判据：**改验收标准前先问它是不是在降低门槛**；降低了就必须留痕，不许静默改写。

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
| **参考 deepseek-harness 补代码前** | 本机源码路径是 `C:\Users\EDY\Desktop\code_mine\deepseek-harness`；先读 `docs/11-微内核与插件容器.md` §4「不拿什么，以及为什么」——那个仓库有 `ask`、有「没有特权内核」、有 51 个包，这三条小明都刻意不要 |
| 做 M3 任一段之前 | `docs/M3-阶段划分.md`（八段的边界、验收与反向演练清单） |
| **动界面样式或加设置项之前** | `docs/12-桌面端界面与设置.md` §3「不拿什么」+ §4「三层 token」+ §8「设置中心的可写边界」；分段见 `docs/M3.5-阶段划分.md`。**界面借鉴的是 deepseek-harness 的 web 端，但不拿左侧会话侧栏**（顶栏 tabs 是 ADR-0037 拍过板的），也不拿插槽体系、CSS Modules 与 Figma 坐标注释 |
| 改 Code Mode 之前 | ADR-0061（做什么）+ ADR-0069（跑在哪）+ ADR-0072（子调用怎么记），外加 `docs/10 §9.5.6` |
