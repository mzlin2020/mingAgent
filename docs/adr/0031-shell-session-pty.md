# ADR-0031 · `shell.session`（PTY）：M1-d 最后一项交付

- **状态**：🟢 Accepted（2026-08-08）
- **日期**：2026-08-08
- **相关**：落地 [docs/09 C7](../09-待讨论的开放问题.md)（`shell.session` 落地前必须先
  拍板的六个开放问题）；复用 [ADR-0003](./0003-默认权限策略.md)/[ADR-0017](./0017-地基复审二-注入防御与红线能力错位.md)
  （YOLO 跳过 `ask`、不跳过任何 `deny` 的语义）、[ADR-0026](./0026-命令的主张分解与argv契约.md)
  （主张分解）、[ADR-0030](./0030-桌面端三档审批模式.md)（三档审批模式）；**不修改**
  以上任何一份定下的判定逻辑；提及 [ADR-0016](./0016-原生模块与打包.md)（原生模块两轨
  ABI）、[ADR-0004](./0004-主界面形态.md)（观察面板定位）、[ADR-0015](./0015-进程与IPC边界.md)
  （IPC 背压遗留）、[ADR-0021](./0021-流式渲染与第二份状态的边界.md)（在途缓冲）

## 背景

M1-d（"能跑命令、能上网"）写明的两条 DoD 已经全部达成，概览表里剩的最后一项交付是
`shell.session`（PTY）——一个真正的交互式终端，区别于`shell.exec`"一次调用、一条
命令、有明确开始结束"的模型。docs/09 C7（2026-08-08 提出）已经把这件事点名为"正面
改动权限判定循环与工具执行生命周期这两处刚稳定下来的机制"，列出六个必须先拍板、不
能边写边改的问题，并建议"先出 ADR，不要求同批写完实现"。

用户要求这一轮把六个问题定案之后，接着把最小可用版本也做出来。规划前用三个问题跟
用户确认了三处关键取舍：**打开会话时问一次、之后完全信任**（不逐条重新判权）、
**终端输出复用现有 `EventBus` 推流**（不做背压重投）、**这一轮定案之后接着实现**
（不是只出文档）。这份 ADR 记录六个问题的定案结论，以及据此落地的最小可用版本。

## 决策：C7 六个问题逐一定案

### 1. 工具执行生命周期要不要引入"跨 turn 常驻会话"新抽象

**要，但不改内核的调用模型。** 新增四个独立工具——`shell.session.open` /
`.write` / `.resize` / `.close`（不是一个工具带 `action` 字段，与 `fs.read`/
`fs.write`/`fs.delete` 拆开命名同一个风格）。真正跨调用存活的句柄由
`packages/tools-core/src/pty-session.ts` 的 `PtySessionManager` 持有——它跟
`nodeToolGateway`/`nodeCheckpointer` 一样是"内核判完之后，具体怎么做"的那一半，
内核完全不知道它的存在。

**全应用共享一个 `PtySessionManager` 实例，不是按 xm 会话现造。** 原因很直接：
`apps/desktop/src/main/services.ts` 里 `ToolRegistry` 本来就是全应用共享的一份
（所有会话注册的工具定义相同），按会话现造反而要多一层"给每个会话建一套工具"的
装配代码。真正需要隔离的是**数据**，不是工具——`PtySessionManager` 内部按
`xmSessionId` 分区，`write`/`resize`/`close` 都要求调用方传入 `ctx.sessionId`
并核对它与 PTY 归属一致（不一致时报"不存在或已经关闭"，不单独报"这是别人的"，
避免把"这个 ID 存在，只是不归你"泄露给不该知道其它会话情况的调用方）。这与
`ApprovalModeStore`（ADR-0030）是同一个形状。

上限与超时：单个 xm 会话最多 4 个并发 PTY；30 分钟无输入输出自动关闭
（`idle_timeout`）；应用退出时 `close()` 里调用 `disposeAll()` 直接收尾，不等
空闲超时。

### 2. 命令级判权 vs 会话级判权

**会话级：打开时问一次，此后完全不再判权。** 不尝试从连续字节流里切分"一条完整
命令"——那是 C7 原文点出的"依赖运行时环境的构造，没有干净解法"。具体做法：

- `shell.session.open` 声明 `capabilities: ['shell.session']`，是**唯一的判权点**。
- `shell.session.write`/`.resize`/`.close` 声明**空能力集** `capabilities: []`——
  不是"依赖用户把 scope 选成 session"，而是结构性地不再产生任何 claim。

**必须诚实地说清楚代价：红线与所有 deny 规则对会话内容零覆盖，不是"仍然生效"。**
`evaluate()` 判的是 claim，`write` 不产生任何 claim，也就没有东西可判——内置的
敏感路径读/持久化写/SSRF/危险命令 deny（ADR-0025/0027/0028/0026）与用户自己写的
deny，都不会被会话内敲的任何内容触发。这与 ADR-0030 里"帮我批准/完全访问权限仍
按红线判"不是同一件事：那里红线仍然逐条检查 claim，只是被跳过的是 `ask`；这里从
一开始就没有 claim 产生。缓解只能是流程性的：

- `open` 的 ask 文案分量比 `shell.exec` 更重，明确写"打开后你在里面敲的所有内容
  不再逐条审批，包括本来会被红线拦截的操作"。
- 内容对用户实时可见（`TerminalPanel`），随时可以点关闭强制结束。
- `shell.session.closed` 落一条持久事件，带截断后的回放尾巴，审计能看到"结束前
  发生了什么"。

`open` 本身的 target 是规范化后的 cwd（新增能力 `shell.session` 的
`TargetKind` 定为 `'path'`），cwd 路径类的既有规范化/红线管道仍然覆盖"在哪打开"，
只是不覆盖"打开后敲了什么"。

新增能力 `shell.session`（`packages/contracts/src/permission/capability.ts`）
额外加入两张表：

- **`IRREVERSIBLE_CAPABILITIES`**：`shell.exec` 不在这张表里，因为它的内容会被
  `analyzeArgv`（ADR-0026）拆成更细的 claim，真正不可逆的部分由那些 claim 自己
  标记；`shell.session` 刻意不做这种拆解，粗粒度的 `open` ask 是唯一判断点，
  所以它自己必须直接算不可逆——否则提示词注入降级（ADR-0003/0017）在 PTY 这条
  路径上形同虚设。
- **`UNTRUSTED_CONTENT_CAPABILITIES`**：终端里 `curl`/`cat` 回显的内容一旦被
  模型读回上下文，与 `net.fetch` 拿回来的是同一种攻击面。

`packages/kernel/src/policy/defaults.ts` 的 `BALANCED_DEFAULT_RULES` 新增一条
`def.shell-session`（`effect: 'ask'`，与 `def.shell-exec` 同形状）。**不改
`engine.ts` 一行**——YOLO 跳过这条 `ask`、红线/用户 deny 不受影响，是
ADR-0017/ADR-0030 验证过的同一套机制，`shell.session` 只是接入它的第 N 个能力。

### 3. `SessionState.pendingPermission` 从单槽改队列

**不改，本轮不需要。** 实测确认 `packages/runtime/src/turn.ts` 的
`dispatchCall` 目前是顺序 `await` 的（`for (const call of calls) { await
dispatchCall(...) }`），ADR-0005 描述的并发调度器还没有实现——同一个 turn 内
不可能有两个同时挂起的 ask。`shell.session` 的四个工具同样通过这条顺序循环
分发，不引入新的并发 ask 场景。子 Agent（`runningSubagents`）是否会并发触发
ask，是一个独立于 PTY、本来就存在的问题，本轮不处理。

### 4. `node-pty` 的 N-API 现状

**已核实，采用它。** 上游 `microsoft/node-pty` v1.1.0（2025-12-22）唯一生产
依赖是 `node-addon-api`（`binding.gyp` 定义 `NAPI_VERSION`），`install` 脚本
先试自带的 prebuild、失败才退回 `node-gyp rebuild`，不再需要 `electron-rebuild`
——与本项目现役唯一原生依赖 `better-sqlite3` 同一姿势（ADR-0016 的"两轨 ABI"
担忧目前有解）。**但发布的 npm 包只随附 `win32-x64`/`win32-arm64`/
`darwin-x64`/`darwin-arm64` 的 prebuild，不含任何 Linux 架构**——Linux 上
`pnpm install` 会本地编译，需要 `g++`（本次在一个没有预装 C++ 编译器的沙箱里
被实测拦住，装上 `g++` 之后编译与运行都正常）。

Go/no-go 验证：把编译好的模块用 `ELECTRON_RUN_AS_NODE=1` 加载进本项目钉住的
Electron `43.3.0`，`require('node-pty')`、`spawn` 一个真实 shell、写入
`echo PTY_SMOKE_OK && exit`、读到匹配的输出——全部通过。结论：采用
`node-pty`；`electron-builder.yml` 的 `asarUnpack`/`npmRebuild: false` 按
"与 better-sqlite3 同样处理"沿用，Linux CI/开发机需要保证 `g++`/`make`/
`python3` 可用（GitHub Actions 的 `ubuntu-latest` 默认自带，不需要额外步骤）。

依赖放在 `packages/tools-core`，不是 `apps/desktop`——与 `better-sqlite3` 放在
`packages/storage` 同一个原则：原生模块跟着**实际使用它的包**走，不是跟着
Electron 应用走（CLI/headless 用的是同一批工具，M3）。

### 5. 终端输出的 IPC 推流方式

**复用现有 `EventBus → webContents.send`（用户已选定），且经核实无需任何新
IPC 代码。** `apps/desktop/src/main/ipc.ts` 里 `services.bus.subscribe((event)
=> { ... win.webContents.send(CH.event, event); })` 本来就是一条**通用**转发
——任何发布到总线上的事件都会被推给渲染层，不需要为新事件类型单独接线。新增
的 `shell.session.opened`/`output`/`closed` 三个事件类型只要通过
`SessionRuntime.record()` 落地，就会自动流过这条既有管线。

新增事件三元组仿照 `message.start/delta/end`、`tool.start/progress/end` 的既有
形状，但键是 `ptySessionId`，不是 `callId`——因为它的生命周期跨越 `open` 这一次
调用之后：

```ts
'shell.session.opened': { durability: 'persisted', ... }  // { ptySessionId, cwd, cols, rows }
'shell.session.output':  { durability: 'transient', ... }  // { ptySessionId, chunk }
'shell.session.closed':  { durability: 'persisted', ... }  // { ptySessionId, exitCode?, reason, tail }
```

`output` 是 transient（跟 `message.delta` 同一类，`TRANSIENT_EVENT_TYPES` 从
两个扩到三个），高频输出（`top`、日志洪水）可能丢帧/有延迟——这是已知限制，
接受它，MessagePort 直连仍然是 ADR-0015 的独立遗留项，不该被这一个功能顺带
决定。`tail` 是定长环形缓冲（超限丢弃更早内容），**没有**照搬
`shell-exec.ts` 的 blob 落盘超限那一套——v1 的目标是先跑起来，完整无损回放
留给以后要做的时候再加一个可选的 `tailRef` 字段（按 ADR-0008 的演进规则不需要
动 version）。

`packages/kernel/src/state/reduce.ts` 新增 `ptySessions:
ReadonlyMap<PtySessionId, OpenPtySession>` 到 `SessionState`（`opened` 时加入、
`closed` 时删除），让回放出的状态能看出"这个会话当时是开着的"，不用等到看完
`closed` 才知道——与 `runningCalls` 同一个理由。`packages/kernel/src/state/
live-buffer.ts` 的 `LiveBuffer` 新增 `terminals:
ReadonlyMap<PtySessionId, LiveTerminal>`，专门处理一个与 `message`/`calls`
不同的归零时机：**PTY 会话跨 turn 存活，`turn.end` 不该把它冲掉**——只有
`shell.session.closed` 才把对应记录标记为已结束（不删除，让用户在关闭面板前
还能看到最后的输出）。

### 6. UI 侧的终端渲染选型

**`@xterm/xterm`**（ADR-0001/03 早就选型过，唯一合理选项）。新增
`apps/desktop` 渲染层依赖，组件是写死的 `TerminalPanel`/`TerminalView`
（`App.tsx`），与今天的 `PermissionCard`/`ApprovalModeSwitcher` 同一量级——
**不是** ADR-0004/docs-05 规划的那套通用插件化观察面板/渲染器注册表，那套
系统本身还没做出来，是独立的、更大的工程，本轮不碰。

`TerminalPanel` 只读渲染 `live.terminals`（每个 PTY 会话一个 `xterm.js`
实例，只写增量、不重复写全量），出现在消息流里 `LiveCalls` 与
`PermissionCard` 之间，跟随会话打开/关闭自然出现/标记为已结束。**v1 不接受
用户直接往终端里敲字**（`Terminal` 建成 `disableStdin: true`，也没有接到
`shell.session.write` 的输入通路）——是模型在开、模型在敲，人在看，这正是
ADR-0004"观察面板"定位的直接延伸，也是本轮刻意收窄的范围。

## 后果

- M1-d 概览表里最后一项交付落地：模型现在能打开真正的交互式终端跑长时间/全屏
  刷新的程序，用户能实时看到里面发生了什么。
- `packages/kernel`/`packages/contracts` 的改动全部是**新增**（新能力、新事件
  类型、`SessionState`/`LiveBuffer` 各加一个字段），`evaluate()`/`engine.ts`
  零改动——两个新模式复用的都是已经验证过的既有机制。
- 红线/deny 对 PTY 会话内容零覆盖是结构性代价，且比 ADR-0030 的"帮我批准"更
  彻底（那里红线仍逐条判，这里从一开始就没有 claim）——这一点在 `open` 的 ask
  文案、本 ADR、docs/06 都写清楚，不是可以事后含糊的细节。

## 反向演练

- `packages/kernel`/`packages/contracts` 既有测试全部不变、全部仍然通过
  ——`evaluate()` 判定逻辑本轮零改动。
- `packages/kernel/tests/policy-engine.test.ts` 新增 `shell.session 的默认
  规则` 一组：balanced 问一次、yolo 跳过、用户自己写的 deny 在 yolo 下依然
  拦得住 `open`。
- `packages/kernel/tests/live-buffer.test.ts` 新增 PTY 会话一组：`opened`
  建记录、`output` 累积、`closed` 只标记不删除、**`turn.end` 不清 PTY 会话**
  （与 message/calls 唯一的形状差异）、`shell.session.output` 在 `reduce`
  里仍是空操作。
- `packages/kernel/tests/persistence-containment.test.ts`（既有测试）自动
  覆盖三个新事件类型的持久化分层：`output` 必须落在 transient 集合，
  `opened`/`closed` 必须落在 persisted 集合。
- `packages/tools-core/tests/pty-session.test.ts`：`PtySessionManager` 的
  open/write/resize/close、归属校验（另一个 xm 会话拿不到这个 PTY 的句柄）、
  并发上限、尾巴截断、空闲超时（含"写入会重置计时器"）、三种关闭原因
  （`exited`/`killed`/`idle_timeout`）；四个工具的能力声明（`open` 只有
  `shell.session`，其余为空）与端到端 open→write→close。
- go/no-go 烟雾测试：`node-pty` 编译产物在 `ELECTRON_RUN_AS_NODE=1` 下加载进
  Electron 43.3.0，真实 spawn/write/读到匹配输出。
- 全量 `pnpm verify`：typecheck（四个 tsconfig）+ eslint + vitest（全量）+
  headless smoke + depcruise（0 违规）+ size-limit（`packages/contracts`
  的体积不受影响，本轮改动未触及它的运行时导出体积）全绿。

## 遗留

以下是本轮刻意不做、如实记录的范围边界：

- **红线/deny 对 PTY 会话内容零覆盖**——结构性代价，不是 bug。如果将来要做
  "会话内容也逐条判权"，需要先回答 C7 问题 2 里"怎么从连续字节流里可靠切出
  一条完整命令"这个 shell 语义问题，本轮判定这不是能靠字符串处理解决的。
- **Checkpoint 机制不覆盖 PTY 会话里发生的文件改动**——`checkpoint.ts` 只认
  `fs.write`/`fs.delete` capability 的 claim，`write`/`resize`/`close` 零
  claim，天然不触发。会话里敲 `rm important.txt` 不会有任何还原点。
- **`pendingPermission` 仍是单槽**——本轮不需要队列（见问题 3），但子 Agent
  并发触发 ask 这个独立于 PTY 的既有风险仍未处理。
- **Windows/macOS 上的 `node-pty` 未做专门验证**——本轮只实测了 Linux；
  跨平台的 conpty/spawn-helper 路径依赖 `node-pty` 自身实现，且 Windows CI
  runner 是否自带编译 Linux 之外架构所需的工具链未核实。
- **`EventBus` 推流没有背压**——高频输出可能丢帧/卡顿，MessagePort 直连仍是
  ADR-0015 的独立遗留项。
- **`shell.session.closed` 的 `tail` 没有 blob 落盘超限那一套**——只有定长
  环形缓冲，完整无损回放需要以后加 `tailRef`。
- **人类无法直接在 `TerminalPanel` 里打字**——v1 只读，是模型在用、人在看。
  要不要让用户接管（比如卡在一个交互式的 `sudo` 密码提示时），以及接管后的
  输入该不该经过判权，是一个新的、需要单独考虑的问题，没有被这次的六个问题
  覆盖到。
- **通用观察面板/渲染器注册表**（ADR-0004/docs-05 规划的插件化面板系统）
  仍未实现，`TerminalPanel` 是本轮写死的一次性组件，不是那套系统的落地。
