# M3-g 收官记录 · 扩展事件与自省闸门

> 日期：2026-08-15
> 结论：✅ 完成。插件事件通道、运行时不变量注册表与四张生成表全部落地并进 `pnpm verify`。

## 基线

开工前 `pnpm verify` 全绿（M3-f 合入之后的 `0b40fa8`）。本段完成后全量门禁重新通过，数字见文末。

## 交付

### 一、扩展事件通道（ADR-0057）

- `EVENT_SPECS` 新增 `ext.persisted` / `ext.transient` 两个信封，载荷同形
  `{ pluginId, name, version, data }`。**此后不再为插件新增事件类型。**
- **删掉了契约包里按 `ext.` 前缀放行的 loose 分支**（`ExtEvent` 与
  `AnyEvent = XmEvent | ExtEvent` 联合）。它零生产者零消费者，而一旦有第一个真实写入者，
  就等于给插件开了一条"任意 type、任意形状直接落库"的路。`isCoreEvent()` 随之消失
  （它变成了恒真），十处调用点一并清掉。
- `prepareExtEvent()`（kernel，纯判断）四步失败关闭：事件名合法 → 清单里声明过 →
  声明层级与信封一致 → 过插件注册的 schema。`createExtRecorder()`（runtime）只负责
  把结果交给 `record()`。
- `reduce()` 对插件事件恒等，只推进 `lastSeq`（seq 是账本不是状态，不推进下一条就撞号）。
- 未安装插件的历史记录：`ReadOptions` 新增 `types` 过滤，`readSession` 单读一趟
  `ext.persisted`，`summarizeExtRecords()` 汇总给渲染层的 `ExtRecordsBanner`——
  **不往 `SessionState` 里加任何插件专用字段**。

### 二、运行时不变量注册表（ADR-0060）

- `@xm/kernel/introspect/invariant.ts`：`InvariantRegistry` + `InvariantError`。
  检查函数的入参只有 `{ event, before, after }`——伪不变量在接口上就写不出来。
- 九个包各发布 `src/invariant.ts`。有断言的只有两个：
  - `@xm/kernel`（4 条）：**不可信上下文下红线能力不得开始执行**、seq 严格递增无空洞、
    `tool.start` 的 callId 不重复、成功的 `tool.end` 必有配对的 `tool.start`。
  - `@xm/runtime`（3 条）：同一时刻只有一个打开的回合、`turn.end` 收的必须是当前那个、
    注入的内容必须真的进入消息流。
  - 其余七个是"空 installer + 一句 `无运行时不变量：` 的理由"，并写明什么条件下该重新审视。
- `SessionRuntime` 在广播之后核一次；违例既抛出，也进 `registry.violations` 清单。
- `scripts/check-invariants.mjs` 进 `pnpm verify`。

### 三、四张生成表（ADR-0060 §二）

`scripts/generate-docs.mjs` 生成 `docs/generated/` 下的事件生产消费表、扩展点挂载表、
工具目录、配置目录，`--check` 模式进 `pnpm verify`（第五张接缝图 M3-b 就有了）。

扩展点挂载表**真装配一次 `test` profile**再问容器 `mounts()`——静态分析看得见
`installStoppingGuard(host)` 这一行，看不见它挂在哪个点上、排第几。为此容器新增了
`mounts()` 自省，`ServiceScope` 顺手拆进 `container/scope.ts`（拆分而非豁免）。

## 反向演练

每条都**先看它红一次**，再把护栏装回去确认转绿。

| # | 演练 | 摘掉什么 | 结果 |
|---|---|---|---|
| 1 | 手改一处生成表 | 把工具目录里 `fs.write` 的风险改成 `safe` | `generate-docs.mjs --check` 退出码 1，指名哪张表 |
| 2 | 伪不变量 | 在 platform 里写一条"`ctx.tools` 服务存在" | `check:invariants` 三条规则同时拒收 |
| 3 | **`trustLevel` 改回硬编码 `'model'`** | `turn-tools.ts` 的 `requestOf` | 见下节 |
| 4 | 未声明的 `ext` 事件 | 摘掉 `prepareExtEvent` 的 `undeclared` 检查 | 内核用例变红（并暴露出第二层拦截，见下） |
| 5 | 未安装插件的历史库 | —（结构性：真 SQLite 库写入 → 关闭 → 重开） | `reduce()` 恒等、事件不丢、汇总标 `installed: false` |

### 第 3 条：这一段的立身之本

把 `trustLevel` 改回硬编码 `'model'` 之后，`packages/runtime/tests/invariants.test.ts`
那条用例变红。真正要证明的不是"它红了"，而是**它靠哪一条断言红的**——所以演练里
把两条常规断言（红线拒绝、被拒调用没有 `tool.start`）**一并删掉**，只留
`expect(registry.violations).toEqual([])`：

```
- []
+ [ { package: '@xm/kernel',
+     invariant: '不可信上下文下红线能力不得开始执行',
+     seq: 13,
+     message: '会话已处于不可信上下文（来自 test.capture 的 gui.capture），
+               工具 test.secrets 却带着 secrets.read 开始执行……' } ]
```

这正是 ADR-0060 要的那件事：常规断言是**可以被顺手改绿**的那种东西，而不变量不行——
要让它绿，只能让那次调用真的不发生。历史上 `trustLevel` 硬编码那次事故活了整整一个
里程碑，靠的就是没有第二条。

### 演练里发现的五处问题（都不是"照做了"）

**一、抛出会被吞掉。** ADR-0060 原文只说"断言失败抛 `InvariantError` 并落审计"。
第一版就是这么写的，而第 3 条演练跑出来**测试照绿、事件流里连 `error.raised` 都没有**——
因为 `executeCall` 为了把工具失败翻译成一条 `tool.end`，catch 掉了一切。
一次真实违例于是变成了"某个工具失败了"。修法：违例同时进 `registry.violations`，
那份清单不会被任何 try/catch 吃掉；headless 冒烟末尾断言的就是它。

**二、ADR 里那条"`tool.start` 与 `tool.end` 一一对应"是错的。** 被闸门拒掉的调用只记
`tool.end`（`failCall`），连 `tool.start` 都不产生。照原文写，第一次真实拒绝就误报——
而 ADR 自己写着"误报比漏报更伤，一次误报会让人把整个机制关掉"。落地改成单向的那一半：
一次 `ok: true` 的结束必有开始。

**三、`context.injected` 的判据第一版写成了消息条数。** 注入落在末尾是用户消息时会
**并进那一条**（`appendInjectedMessage`），条数一位不动——第一版会在最常见的路径上误报。
改成比对块数。

**四、`ext` 的失败关闭有两层。** 摘掉 `undeclared` 检查之后，未声明的事件仍被
`durability-mismatch` 拦下（`undefined !== 'persisted'`）。拒绝的**理由**会变得难懂，
所以那步不能省；但"漏一层就放行"在这条链上不成立。

**五、第一版的扩展点挂载表一眼假。** 四行插件行全被记成 `baseline.turn-driver`——
因为 `installStoppingGuard(ctx.turnExtensions)` 里那个 host 是驱动器造的，
`ctx.pluginName` 自然是驱动器。归属改成"装配到哪一行时挂上的"（容器跟踪
`currentPlugin`）之后才对得上。这条如果没人看一眼生成结果，会以全绿的姿态存在下去。

## 真实装配里的证据

headless 冒烟（一个跑完 M2-a～M2-i 全套任务、170 条持久事件的真实会话）末尾断言：

```
✓ headless 冒烟通过：39 条运行时不变量零违例、170 条持久事件、237 条总线事件……
```

39 条 = 7 个不变量 × 各自声明的事件类型数（`seq` 那条挂在全部 33 种持久事件上）。
持久事件条数与 M3-e / M3-f 完全一致——**自省闸门没有改变任何行为**。

顺带印证了 M3-a 的效果模型：`composition.dispose()` 之后注册表 `size` 归零，
所以冒烟里的条数必须在 dispose 之前取（第一版取晚了，当场报"注册表是空的"）。

## 已知的取舍，写下来免得以后当 bug 查

1. **不变量只跑在写入路径上，不跑回放。** `SessionRuntime.open()` 的回放不核不变量：
   老会话可能带着历史缺陷，开机即报会让人立刻关掉这道闸门。代价是"历史库里已经存在的
   违例"查不出来——要查得单写一个离线扫描器。
2. **`@xm/storage` 将来若长出真的不变量，接不进 `invariant-install.ts`**：
   `@xm/runtime` 依赖不到它。那时要给它单开一行 profile 行。脚本的报错信息里写了这条出路。
3. **`check:invariants` 的伪不变量判据是启发式的**（不读入参 + 名字像"××存在"）。
   它挡得住照着参考实现抄来的那一类，挡不住一个刻意伪装的。真正的护栏是接口本身——
   检查函数拿不到服务。
4. **事件生产消费表的"消费者"列是文本扫描出来的**，会有假阳性（一个文件提到某个事件名
   就算数）。它的价值在**假阴性**那一侧：某个持久事件没有生产者，那多半是一条
   "契约完整、零产出"的死路——`DisplayHint` 与 `checkpoint.created` 都是那么长出来的。
5. **插件事件目前零生产者。** 通道、闸门、UI 说明都在，但第一个真实写入者要等 M4 的
   插件宿主。这是刻意的：M3-g 交付的是机制，而机制的正确性由真库往返用例证明
   （`packages/runtime/tests/ext-events.test.ts` 写真 SQLite、关闭、重开、再读）。

## 门禁

`pnpm verify` 全绿：

- 单文件规模纪律：扫描 229 个文件，均在 400 行线内（**没有新增豁免**——
  `reduce.ts` 与 `container.ts` 两处超线分别靠拆出 `checkpoint-state.ts` 与 `scope.ts` 解决）
- 运行时不变量：9 个包都发布了伴生模块，2 个有断言（共 7 条），均已接入装配
- 五张生成表与代码一致
- 测试：1244 passed | 10 skipped；kernel 覆盖率套件 753 passed（行覆盖 95.27%）
- headless 冒烟：39 条不变量零违例、170 条持久事件，与 M3-f 完全一致
- depcruise：384 modules / 1521 dependencies，零违规（`contracts/src/invariant.ts` 一开始是
  孤儿模块——它是唯一一个不 import 任何东西的伴生模块，从包入口导出后消失）
- size-limit：8.77 kB / 15 kB

## 下一段

M3-h（Code Mode）。**前置未满足**：`docs/09` 的 H2 隔离机制尚未定案，
ADR-0061 仍是 🟡 Proposed——普通 Node worker 给不了它承诺的隔离属性。H2 没定就不开工。
