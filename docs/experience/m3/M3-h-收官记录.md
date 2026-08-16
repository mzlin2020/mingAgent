# M3-h 收官记录 · Code Mode

- **日期**：2026-08-16
- **范围**：`ctx.codeMode` 接缝 + `@xm/code-runtime`（QuickJS 客体域 + worker）+ `run_code`
  工具 + SDK 生成 + 子调用重入十二步链 + 呈现模式
- **决策**：[ADR-0072](../../adr/0072-CodeMode子调用的记录面与再入口.md)
  （落地）· [ADR-0061](../../adr/0061-CodeMode与工具SDK生成.md)（做什么）·
  [ADR-0069](../../adr/0069-CodeMode的隔离机制.md)（跑在哪）·
  [ADR-0071](../../adr/0071-工具的规范JSON输出值.md)（拿到什么形状）
- **结果**：`pnpm verify` 全绿。**M3 至此收官。**

---

## 一、交付了什么

| 层 | 落点 |
|---|---|
| 契约 | `tool.code.dispatch`（persisted，**没有 `forModel` 字段**）；`tools.presentation` 配置 |
| 内核 | `port/code-runtime.ts`（`CodeRuntime` 端口，纯类型）；`ToolContext.codeMode` 接缝 |
| 适配器 | **新包 `@xm/code-runtime`**：QuickJS-WASM 客体域 + 长驻 worker + TS 6 剥类型 + 预算 |
| 运行时 | `CallSink` 把十二步链的记录面参数化；`turn-code.ts` 子调用派发；`code-sdk.ts` SDK 生成；`tools/run-code.ts` |
| 装配 | profile 业务行 `runtime.code`（可用 `withoutCodeRuntime` 去掉）；desktop 注册 `run_code` |

包数 10 → **11**。

## 二、验收

**主验收**（`packages/runtime/tests/code-mode.test.ts`，跑在真 QuickJS + 真 `coreTools`
+ 真网关 + 真红线 + 真文件上）：

一段程序连读三个文件，**模型请求 2 次**（原生形态是 3 次 tool_use 往返 + 1 次收尾 = 4 次），
事件流里 1 条 `tool.start` / 1 条 `tool.end` / **3 条 `tool.code.dispatch`**。

`run_code` 的卡片列出程序内每一步（`presentation.calls`，与事件同源于接缝的 `dispatched()`
账本），程序全文不重复落库——它已经在 `tool.start.input` 里。

**headless 冒烟新增一段 Code Mode**，且它是整个仓库**唯一**跑到 `dist/code-worker.js`
的地方：vitest 里加载的是 `src/code-worker.ts`（靠 Node 22.18 起默认的类型剥离），
生产里加载的是编译产物，那是两个不同的文件。

冒烟数字：**40 条运行时不变量零违例、180 条持久事件、249 条总线事件**
（上一批是 39 / 170 / 237）。三处增量都可解释：

- 不变量 +1：`api.on(PERSISTED_EVENT_TYPES, 'seq 严格递增且无空洞')` 是**按事件类型逐条注册**的，
  新增一个持久类型就多一条。
- 持久事件 +10：新增的那一个回合（turn.start / 两次 message.start+end / tool.start /
  tool.end / 2 条 tool.code.dispatch / turn.end）。
- 总线事件 +12：上面 10 条，加 `run_code` 的一条 `tool.progress` 与流式 delta。

## 三、八条反向演练，逐条看它红过一次

| # | 演练 | 红的样子 |
|---|---|---|
| 1 | 程序写 git 钩子 / 读 `~/.ssh/id_rsa` | 拒绝理由与直接调用**逐字节相同**（用例直接比对两条 `error.message`） |
| 2 | 程序用符号链接指向私钥 | 网关照常 `realpath.native` 并回写；事件里记的是解析后的真路径，私钥内容零泄漏 |
| 3 | 死循环 / 一次要 20M 元素的数组 | `cpu` / `memory`，宿主线程随后立刻还能求值 |
| 4 | `require` / `process` / `fetch` / `Function` 构造器 | 四条探针全部"拿不到"；朴素 Node worker 跑同一段全部"拿到了" |
| 5 | 父 `run_code` 放行、内部 `fs.write` 撞红线 | 父 `tool.end.ok = true`，子 `dispatch.ok = false` |
| 6 | 程序 catch 掉拒绝继续跑 | 模型看到"一切正常"，事件流里那条 `ok:false` 的 dispatch 还在 |
| 7 | 不覆盖客体域的 `Date` / `Math.random` | `AssertionError: expected { t: 1786860976348 } to deeply equal { t: 1786860976406 }`；"时间不流逝"那条从 0 变成 163 |
| 8 | 只留 CPU 预算、去掉宿主墙钟 | `Test timed out in 8000ms` —— interrupt handler 一次都没被问到 |

另有两条本批新加护栏的演练：

- **子调用改用 `modelCallSink`**（即"照常落 tool.start/tool.end"那条被否掉的读法）→
  `code-mode.test.ts` 十条里红七条，其中包括哨兵断言
  `expected '[{"id":"…' not to contain '只在文件正文里出现的哨兵-7b21'`。
  这是最值得留痕的一条：那个改动读起来像"让审计更完整"，实际是把三份文件正文
  塞回每一次后续模型请求。
- **`packages/runtime/src` 里 import `@xm/code-runtime`** →
  `error 内核与运行时不得依赖-code-runtime: packages/runtime/src/turn-code.ts → packages/code-runtime/src/index.ts`。

## 四、实施中被实测改掉的四处

**一、`module: None` 不能用。** ADR-0069 §四 说用仓库已有的 TS 6 `transpileModule` 剥类型。
第一版给了 `module: ts.ModuleKind.None`，它在 TS 6 里已标记弃用、**TS 7 会停止工作**，
当场报错。改成 `ESNext`。代价是 `import` 会原样留在输出里，于是它在包装成函数体之后
变成一条 SyntaxError——`failureKind` 因此把 SyntaxError 归到 `compile`，
模型看到的仍然是"你这段代码编不过"。

**二、`module.newRuntime().newContext()` 的收尾是坏的。** 装过 asyncified 绑定之后：

```
ctx.dispose(); runtime.dispose()
  → QuickJSRuntime(rt = …) not found when trying to free HostRef(id = -2147483648)
只 runtime.dispose()
  → Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,2036)
```

`module.newContext()`（runtime 由 context 自己持有并同批释放）两条都不发生，
上限照样经 `ctx.runtime` 设得上。已写进 `code-worker.ts` 的注释里。

**三、worker 入口必须自成一体。** 它有两条被加载的路径——生产是 `dist/code-worker.js`，
测试是 `src/code-worker.ts`——而**类型剥离不会把 `./x.js` 解析到 `./x.ts`**（已实测：
`Cannot find module '…/dep.js' imported from …/w2.ts`）。所以那个文件里包内的东西
只能 `import type`，客体域的 prelude 因此写在它自己里面，而不是拆出去。

**四、`.git/index` 不是红线。** M3-h 的反向演练清单原本举的就是它，实测被放行——
红线里与 `.git` 有关的是 `**/.git/hooks/**`。例子写错了，判据没变；
已在 `docs/M3-阶段划分.md` 就地更正并说明"不是把标准放宽"。

## 五、顺手修的一处旧洞

`scripts/check-determinism-boundary.mjs` 是**按文本扫**的，不去注释。于是一句
"客体域里 `Date.now()` 的取值来自 ctx.clock" 这样的**说明文字**会被算成一次环境直调。

本批撞上两次（`port/code-runtime.ts` 与 `tool/types.ts`）。不修的话，下一个人只有两条路：
改注释措辞，或者把闸门放宽——而第二条路迟早会有人走。已改成先去注释再扫
（与 `check-invariants.mjs` 同一招），并演练确认**源码里真写一次 `Date.now()` 仍然被抓**。

## 六、已知取舍

- **客体域是解释执行**，字符串处理实测比宿主 V8 慢 15.2×（ADR-0069 §五）。
  SDK 提示词里没有写这一条——写了也未必影响模型的选择，而 `run_code` 的描述已经说清了
  它的用途是"一次调用里连做多步"。若实测发现模型在程序里做重计算，再补。
- **`run_code` 的规范输出值里 `value` 是 JSON 文本**，不是结构。规范值的 schema 必须落在
  可序列化子集里，而 `z.unknown()` 是被禁的（它等于没有约束）。用 `hasValue` 把
  "返回了 null"与"什么都没返回"分开。它今天没有消费者——不做嵌套 `run_code`，
  所以没有程序能调它；留着是为了统一，和过 `generate-docs` 的那道闸门。
- **子调用不转发 `tool.progress`。** 程序里的一次子调用没有对应的 UI 位置；真要显示，
  该由 `run_code` 自己的进度流表达，而不是让子调用冒充一次顶层调用。
- **打包面**：`.wasm` 要进 `asarUnpack`（与 better-sqlite3、tree-sitter 同一个坑），
  `dist/code-worker.js` 也要真的被打进去。桌面打包验证不在本批范围。

## 七、下一段

**M3 收官。** 下一阶段是 **M4「能扩展」**：三方插件隔离决议（`docs/09` 的 H1）、
MCP 与它的污点传播（G2）、Skill 加载器、多 Provider 角色路由、配置中心、`xm` CLI 产品化。

ADR-0061 的**重新评估条件**从今天开始生效：如果实测发现模型在 `both` 模式下几乎不用
`run_code`，或者写出来的程序失败率高到要靠更多往返去修，就按那条把 Code Mode 降级为
实验特性——**不要继续加功能去救它**。
