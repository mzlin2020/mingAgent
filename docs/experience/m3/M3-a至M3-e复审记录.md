# M3-a ～ M3-e 复审记录

> 日期：2026-08-15
> 范围：`8bb750c`（M3-a～M3-d）与 `4375fd6`（M3-e）两个提交
> 结论：方向没走偏，安全底座的关键约束都真实落地了；发现 6 处问题，全部已修，
> 每处各配一条会红的反向演练。

## 1. 复核通过的部分

| 检查项 | 结论 |
|---|---|
| 十二步链的顺序与特权链段 | ①–⑤ 在 `prepareCall()` 内闭合，扩展点拿不到插入点；⑥ 的 waterfall 包住 ⑦ 的 `evaluate()` |
| 扩展点只能收紧 | `dispatchCall()` 有运行时单调性检查，同时覆盖"没跑过终局判定"与"下游 deny 被翻回 allow"两种形状，不只押在 TypeScript 上 |
| ⑥ 不得改写 `input` | `prepared.input` 深冻结、`ctx` 冻结，且 ⑧/⑨ 直接消费 `prepared` 而不是传给监听器的那个对象 |
| 业务工具整包零 `node:*` | `packages/tools-core/src` 实测 0 处 `node:` import；depcruise 规则从文件名单升级为 `dependencyTypes: ['core']` 的整包边界 |
| 原则二的物理删包验收 | `scripts/typecheck-workspace.mjs` / `scripts/smoke.mjs` 按包是否物理存在切换 `tsconfig.no-tools.json` 与空工具冒烟；**没有被换成"删配置行"那条更容易通过的验收** |
| 基线不可 patch | `assertBaseline()` 同时校验基线行的存在、身份与**顺序**；`applyProfilePatch()` 拒绝 update/insert/锚定基线行 |
| 确定性 | `check-determinism-boundary.mjs` 的过渡清单已归零；compose 的逐字节事件流快照不做任何字段规范化 |
| 容器 | `waterfall` 真 await、`AbortLike` 是第一参数、`parallel` 用 `allSettled` + `AggregateError`、效果 LIFO 撤销、`inject` 缺失 fail loud 并指名插件与服务 |
| 反向演练 | M3-a～M3-e 各段收官记录里的演练是真做过的（先红后绿），不是事后补写的描述 |

`pnpm verify` 在复审开始时全绿（355 模块 / 1405 依赖零违规，kernel 行覆盖 96.10%）。

## 2. 发现并已修复

### 2.1 回合中注入破坏消息角色交替（一级）

`context.injected` 的投影无条件新起一条 user 消息。子 Agent 回传走的正是回合中注入，
于是消息序列变成 `assistant(tool_use) → user(注入) → user(tool_result)`——两条相邻 user 消息，
且 `tool_result` 不再紧跟 assistant。实测发给 Provider 的角色序列为
`["user","assistant","user","user"]`，真实 Provider 会 400。

**这条缺陷全套测试与 headless 冒烟都是绿的**，因为 `ScriptedProvider` 不校验消息形状。
定案与修复见 [ADR-0064](../../adr/0064-Inbox的持久化边界与steer生效时点.md) §一的补记。

### 2.2 执行收据没有与本次调用绑定（一级）

`isExecutionReceipt()` 只查模块私有 `WeakSet` 的成员身份，不比对 `callId` / `toolName`——
而这两个字段正是 ADR-0062 为绑定而定义的。一个 `tool/execute` 环绕插件缓存上一次真实执行的
收据、挂到下一次短路结果上即可通过 ⑫：收据是真的，执行没发生。
定案见 [ADR-0062](../../adr/0062-扩展点的异步契约与执行收据.md) §三补记。

### 2.3 点停止不清空未认领队列（二级，用户可感知）

`Agent.interrupt()` 只 abort 当前步骤，排队中的 followup / steer 原样留着，
下一次发消息时被一起认领发出去。定案见 ADR-0064 §二补记。

### 2.4 `installContextBuilder` 丢弃下游返回值（三级，潜伏）

它 `await next()` 之后无条件用自己构造的请求覆盖，违反 ADR-0055
"包装 `next()` 的监听器有责任保留下游的修改"。今天无害——它恰好是最内层监听器；
但 `patch.insert` 往 `runtime.context` 之后插一行，那行的 `turn/pre-step` 就被静默吞掉。
已改为"下游已产出请求就用下游的"。

### 2.5 ⑧ 的环绕插件无法收紧 `signal`（二级，文档写着代码没有）

ADR-0055 §一硬约束 3 与 ADR-0062 §二.2 都写明：环绕包装**只许**替换 signal，可以为一次调用
套一个更短的截止时间。但实现里 `prepared.ctx` 是冻结的、⑨ 直接用它，监听器没有任何入口。
也就是说 ADR 给 ⑧ 留的**唯一**一件事恰好是它做不到的那件，而 ⑧ 的典型用途
（超时、熔断）全都依赖它。方向上不是安全问题（做不到是保守方向），但形状很坏：
**文档里写着、代码里没有、没有闸门会发现**。

已按方案 A 补上机制：waterfall 的 `next` 接受可选 `AbortLike`，容器 `mergeAbort` 取并集后
交给后续监听器与最内层核心，驱动器把它换进 `ToolContext`。用并集而不是替换，
"只能收紧"就是结构性质。定案见 ADR-0055 §一硬约束 3 的定案块。

### 2.6 工具执行途中点停止会把 `runTurn` 掀成异常（一级，M3-c 引入）

顺着 2.5 的测试照出来的连带缺陷。扩展点派发对已 abort 的 signal 一律抛
（ADR-0062 §二.2），而**用户点停止最常见的时机就是"工具正跑着"**——工具执行完紧接着的
`turn/stopping` 于是抛 `DispatchAbortedError`，`runTurn` 以异常收场而不是干净返回
`'aborted'`。桌面那边表现为 `sendUserMessage` 报错 + `Agent` 循环里一条未处理的 rejection。

`interrupt.test.ts` 原有的四条用例**全部在模型流式输出阶段 abort**，没有一条覆盖工具阶段，
所以这条缺陷在全绿的测试下活着。已在驱动器里把取消兑现在派发扩展点之前，并补上覆盖用例。

## 4. 其它记录

- `context.injected` 若发生在**任何回合之外**，不属于任何回合切片，
  因此永远不进 `coveredIds`、永远不被压缩覆盖（ADR-0048）。长会话里大量后台注入会让这部分
  只增不减。当前没有产生该形态的生产路径（唯一的注入来源是子 Agent，一定在回合内），
  M5 接入定时任务 / 后台 job 之前必须处理。
- `agents` Map 随会话只增不减，且缓存了首次传入的 `SessionRuntime`。当前 `runtimeFor()`
  同样缓存、生命周期一致，所以没有实际问题；会话句柄一旦可以被关闭重开，两者必须一起失效。
- CLAUDE.md 的分层 ASCII 图仍写着旧的四个适配器包，包表已经更新——图与表不一致。
