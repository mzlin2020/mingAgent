# ADR-0069 · Code Mode 的隔离机制（H2 定案）

- **状态**：🟢 Accepted
- **日期**：2026-08-15
- **相关**：[ADR-0061](./0061-CodeMode与工具SDK生成.md)（本 ADR 解除它的 🟡 降级）· [ADR-0055](./0055-Turn驱动器的扩展点契约.md) · [ADR-0053](./0053-微内核的特权底座与扩展点边界.md) · [ADR-0066](./0066-时钟与ID的注入.md) · [ADR-0005](./0005-工具并发与资源声明.md) · [ADR-0028](./0028-web.fetch的IP级SSRF判定与DNS重绑定防护.md)

## 背景

[ADR-0061](./0061-CodeMode与工具SDK生成.md) §一 写着：程序**不应**拿到 `node:fs`、
`child_process`、`net`。2026-08-14 的复审发现初稿把"不应"写成了"拿不到"，
而普通 Node worker 天生拥有全部内建模块——一句 `require('fs')` 就穿过去，
"不注入绑定函数"挡不住任何人。**一份兑现不了自己承诺的 ADR 不能是 Accepted**，
它因此降级为 🟡 Proposed，隔离机制留给 `docs/09` 的 **H2**。

H2 当时列了三个候选，并写下倾向：**独立子进程 + Node permission model**——
理由是"三者里唯一由操作系统与运行时共同兜底、不需要自研沙箱"。

本 ADR 先去实测那个倾向，然后按实测结果定案。完整数据见
[H2 隔离机制验证记录](../experience/m3/H2-隔离机制验证记录.md)。

## 选项

### 选项 A：独立子进程 + Node permission model（原倾向）

`node --permission`（不给任何 `--allow-*`）实测：

| 探针 | 结果 |
|---|---|
| `fs.readFileSync` | `ERR_ACCESS_DENIED` ✅ |
| `child_process.execSync` | `ERR_ACCESS_DENIED` ✅ |
| `net.createConnection` | **允许**（拿到 `ECONNREFUSED`，connect(2) 真的发出去了）❌ |
| `fetch('https://…')` | **HTTP 200，真的出网** ❌ |

**Node 的权限模型没有网络这一档**，也没有任何开关能补上。这不是配置没写对，
是这个机制的覆盖范围就到这里。

而网络恰好是本项目威胁模型里最要紧的那一格：程序可以先用工具读一个文件——那一步有闸门、
有 `tool.start` / `tool.end`、有污点传播——再**裸 `fetch` 发出去**，这一步没有闸门、
没有事件、绕开 [ADR-0028](./0028-web.fetch的IP级SSRF判定与DNS重绑定防护.md) 的 IP 级判定。
一次完整的外泄，审计里只看得见"读了个文件"。

补网络这个洞只剩 OS 级防火墙一条路（Linux seccomp/netns、macOS 与 Windows 各一套），
那正是"自研安全原语"，与选它的理由自相矛盾。

> 顺带确认：Electron 43 在 `ELECTRON_RUN_AS_NODE` 下**认** `--permission`。
> 所以否掉它不是因为跑不起来，是因为**它挡错了地方**。

### 选项 B：SES / `vm` + 冻结 realm

`lockdown()` 冻的是**整个宿主进程**的 intrinsics，会波及 zod、better-sqlite3 与所有既有代码；
绑定函数是宿主对象，membrane 稍有疏漏就是
`binding.constructor.constructor('return process')()` 直通；且同步死循环在没有 worker 时打不断。

### 选项 C：QuickJS-WASM 客体域 + worker 线程

## 决策

**选 C：程序跑在 QuickJS-WASM 客体域里，客体域跑在 worker 线程中。**

两层，各挡一件事，都**不是**安全边界：

| 层 | 挡什么 |
|---|---|
| QuickJS 客体域 | **权限隔离**：客体域是另一个引擎，全局面只有 ECMAScript 内建，没有任何宿主 API |
| worker 线程 | **稳定性隔离**：长时间占用不阻塞主循环。interrupt handler 能中断客体域，但它在宿主线程上跑，预算窗口内会冻住 Electron 主进程 |

### 一、安全立场不变

> **隔离始终不是安全边界。越权由 [ADR-0055](./0055-Turn驱动器的扩展点契约.md)
> 的十二步闸门链挡。**

隔离要挡的是"程序绕过绑定直接干活"，与"程序调工具时越权"是两件事，后者由闸门负责。
ADR-0061 §一 的这条立场一字不改，本 ADR 只是给它配上一个**真能兑现**的机制。

与选项 A 的差别在形状而不在强度：客体域是 **deny-by-default 的结构性隔离**——
不是"枚举要关掉的能力"，而是"那里本来就什么都没有，能力只从注入的绑定进来"。
没有"忘了关的那一档"，因为没有档。

### 二、客体域的全局面是契约的一部分

实测 62 个名字，全是 ECMAScript 内建；`require` / `process` / `fetch` /
`XMLHttpRequest` / `WebAssembly` / `std` / `os` / `setTimeout` / `console` 一个都没有。
完整清单见验证记录，并被 `evals/spikes/h2-code-runtime-isolation.test.ts` 逐名钉死。

那条断言按"**允许存在什么**"写，不按"不允许存在什么"写：后者会漏，
因为写清单的人想不到 `std`。这与 [ADR-0063](./0063-安全底座与工具实现的包边界.md)
把"工具不得碰 `node:*`"从文件名单升级成包边界规则，是同一条纪律。

### 三、M3-h 必须遵守的四条（全部来自实测）

1. **`Date` 与 `Math.random` 在客体域里是存在的**，它们是语言内建、不是宿主 API。
   装载绑定时必须把它们换成 `ctx.clock` / `ctx.ids` 的投影
   （[ADR-0066](./0066-时钟与ID的注入.md)），否则 Code Mode 是确定性闸门上的一个洞——
   `pnpm check:determinism` 扫仓库源码，扫不到模型现写的一段程序。
2. **绑定是同步形态**，asyncify 把宿主那侧的 `async` 折叠掉。生成的 SDK 是**同步签名**，
   程序里不写 `await`。ADR-0061 §五 那句"生成成一个 TS 异步函数"按此修正：
   `await` 那条路实测会让程序静默半途而废并在 wasm 层崩。
3. **必须有宿主侧的墙钟截止时间。** interrupt handler 是 CPU 预算：程序停在一个永不 settle
   的 promise 上时没有字节码在跑，它一次都不会再被问到。"到点仍未完成"要判成失败。
4. **一个程序一个 WASM 模块。** 内存上限在被别的 runtime 用过的模块上不再生效
   （实测把宿主 V8 堆撑到 2 GB）。冷启动 21 ms，不值得省。

### 四、语言与转译

只做 TypeScript（ADR-0061 不变）。剥类型用**仓库已有的 TS 6 编译器 API**
（`typescript` → `@typescript/typescript6`，本来就为 typescript-eslint 装着）的
`ts.transpileModule`，**不引入新的转译器**。转译在 worker 里做，主进程不加载 TS
（首次加载 778 ms，之后每次转译 43 ms）。

这条同时受 [ADR-0010](./0010-TypeScript双编译器工具链.md) 的约束：TS 6 是 **API**、
TS 7 是**编译器**，两者不混。这里用的是 API 那一侧，与既有纪律一致。

### 五、代价

- 客体域是解释执行，字符串处理实测比宿主 V8 慢 **15.2×**。
  **客体域适合编排，不适合重计算**；要算就调工具让宿主算。
  单次绑定往返 0.20 ms，相对模型往返可忽略——Code Mode 的收益来自省往返，这个开销吃不掉它。
- 新增一个 WASM 依赖（`quickjs-emscripten-core` + 单一变体，MIT，无安装脚本）。
  打包时 `.wasm` 要进 `asarUnpack`，与 better-sqlite3、tree-sitter 同一个坑。
- 客体域里的错误栈是 QuickJS 的，与宿主栈对不上，调试体验比 worker 差。

### 六、不做的

- 不选进程级沙箱作为**网络**边界（见选项 A）。将来若真需要进程级隔离
  （例如 H1 的三方插件宿主），那是另一件事，不要用它替换本 ADR 的客体域。
- 不给客体域任何直通能力。想要就调工具，让闸门看见。
- 不为并发在客体域里做文章：并发调度与资源冲突检测归宿主
  （[ADR-0005](./0005-工具并发与资源声明.md)），不由模型现写的一段程序决定。

## 后果

- **正面**：ADR-0061 的隔离承诺第一次有了能兑现它的机制，那份 ADR 随本 ADR 恢复 🟢 Accepted，
  M3-h 的前置一解除。
- **正面**：客体域在浏览器、headless、CLI、Electron 主进程里表现一致，
  不需要为每个形态各写一套（选项 A 要在 Electron 里靠 `ELECTRON_RUN_AS_NODE` + `process.execPath` 绕）。
- **负面**：本仓库第二个 WASM 依赖，打包面又多一处要照顾的地方。
- **负面**：15.2× 的计算开销是真实的。若实测发现模型倾向于在程序里做重计算，
  要么在 SDK 文档里讲清楚，要么按 ADR-0061 的"重新评估条件"降级 Code Mode，
  **不要为了救它去换一个更快但更漏的隔离机制**。

- **必做的反向演练**（第一条已在本批完成并看它红过一次）：
  1. 把提供者换成朴素 Node worker，跑同一段探针 → "全部拿不到"那条断言必须变红，
     四个字段一个不落翻成"拿到了"。**已验证**（见验证记录 §二）。
  2. QuickJS 升级后全局面多出一个名字 → 逐名钉死那条断言必须红。
  3. M3-h 落地后：程序里调一个撞红线的工具 → 拒绝理由与直接调用一模一样。
  4. M3-h 落地后：不给绑定注入 `Date` 覆盖 → 确定性快照必须红。
  5. M3-h 落地后：让程序停在一个永不完成的 promise 上 → 墙钟必须把它判失败；
     去掉墙钟只留 interrupt handler，这条必须红。

- **重新评估条件**：QuickJS 客体域出现可用的逃逸（不是理论上的，是有 PoC 的），
  或者 Node 的权限模型补上了网络这一档——后者会让选项 A 重新成立，
  那时要重算"多一个进程"与"多一个 WASM 依赖"的账，而不是自动切换。
