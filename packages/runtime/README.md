# `@xm/runtime`

M2-a 新增内建 `todo.update`：工具通过 ADR-0041 的窄 `TodoUpdater` 写入当前会话的 `todo.updated`，不向 `ToolContext` 暴露通用事件写入口。提示词只在该工具实际可用时引导三步以上任务维护清单。

M2-b 新增内建 `result.expand`：完整 hash 只是定位符，工具只读取当前会话已持久化 `tool.end.fullRef` 可达的 Blob，并按行范围流式展开；跨会话 hash 不可读取（ADR-0042）。

**装配层**：把内核（纯逻辑）、存储（端口实现）、Provider 与工具拼成一个可运行的
headless 引擎。

## 这个包负责什么

| 模块 | 职责 |
|---|---|
| `src/session-runtime.ts` | 一个会话的运行时。**全系统唯一分配 `seq` 的地方** |
| `src/event-bus.ts` | 进程内发布订阅，支持 `fromSeq` 续读 |
| `src/turn.ts` | 极薄的 Turn 循环：Provider → 事件 → 权限闸门 → 工具 → 事件 |
| `src/provider/scripted.ts` | 按剧本吐 chunk 的 Provider（冒烟、回放、评测都用它） |
| `src/tools/demo.ts` | 两个零 I/O 的玩具工具，覆盖闸门的三条路径 |
| `src/tools/result-expand.ts` | 当前会话截断工具结果的 Blob 可达性校验与按行展开 |

## 不负责什么

- **electron**。`apps/cli`（M3）与 headless 冒烟都要用本包。
- 真实 Provider、真实工具集、SecretStore、审批 UI（M1）。
- ContextBuilder、上下文压缩、并行调度、子 Agent（M1/M2）。
  `turn.ts` 刻意不完整——半成品的上下文装配比没有更难拆。

## 三条容易被破坏的约束

**一、`seq` 只在 `SessionRuntime.record()` 里推进。**
别处拿不到 `#lastSeq`，也就没法自己分配。ADR-0013 不变量三说的"存储只验证、不分配"
在这里才真正成立——它在 M0-a 只是端口注释里的一句话。

**二、广播严格排在 `append` 成功之后（不变量五）。**
反过来写，在追加失败时订阅者会看到一条并不存在的事件。事件流是唯一真相，
UI 上多出来一条永远回放不出来的消息，是那种用户报"它自己删了我的消息"、
开发者查不出来的问题。`tests/session-runtime.test.ts` 里那个会失败的存储专门盯它——
把两行调个个儿，那条用例立刻红。

**三、工具执行前必过 PolicyEngine，且没有旁路。**
一个工具声明多个能力时逐个判定，**任一被拒即整体拒绝**。反过来（任一放行即放行）
会让"同时声明 fs.read 和 fs.delete 的工具"靠 fs.read 蒙混过关。

`ask` 的应答者 `decide` **没有默认值**：headless 下没人能点"允许"，
默认放行会把整条闸门变成摆设。没传就等同于拒绝，冒烟里有一条用例锁着它。

## headless 冒烟

```bash
pnpm smoke      # tsc -b && node scripts/smoke-headless.mjs
```

`packages/runtime/tests/smoke.test.ts` 与 `scripts/smoke-headless.mjs` 验的是同一件事，
但**后者跑的是 `dist/`**。这不是重复：vitest 走源码别名，一次也不会加载真正发布出去的
产物，而 M0-b 的两个真实风险恰好只在产物上暴露——`exports` 写错，以及 better-sqlite3
的原生模块 ABI（Node 与 Electron 是两轨，ADR-0016）。

冒烟要证明的四件事：

- runtime 能在纯 Node 下装配起来（`apps/cli` 的前提）
- 关掉进程、重开库、逐条 `reduce`，得到的状态与内存里的**完全一致**
- 权限闸门长在工具调用的路径上：删家目录被 `red.fs-delete-home-root` 拦下，且**没执行**
- ADR-0008 的分层在真库上成立：`message.delta` / `tool.progress` 一条也没落盘，
  但它们确实上了总线（否则 UI 就没有流式效果）

## 一条被这个包补上的护栏

depcruise 的 `runtime-不得依赖-electron` 从 M0-a 就写着，但在本包出现之前，
它指向的目录并不存在——规则从写下起一次也没匹配过任何模块。

补演练时又发现第二层：即便有了目录，在里面写 `import 'electron'` **depcruise 仍然全绿**，
因为 electron 当时还没装，import 解析不到，那条边压根不进依赖图。
于是四条"不得依赖 electron"的规则只在 electron 已安装时才生效，
而最该拦的恰恰是"某个包偷偷 import 了自己没声明的依赖"。

修法是补一条 `禁止无法解析的依赖` 兜底。这与 ADR-0011 ⑨ 的 `includeOnly` 是同一类失效：
**规则在、输出全绿、实际没管住。**

## 相关文档

- [ADR-0013 存储引擎选型与 EventStore 端口](../../docs/adr/0013-存储引擎选型与EventStore端口.md)
- [ADR-0008 事件持久化分层与演进](../../docs/adr/0008-事件持久化分层与演进.md)
- [docs/04 §5 一次对话的完整链路](../../docs/04-总体架构.md)
