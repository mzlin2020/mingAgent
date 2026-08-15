# M3-f 收官记录 · 渲染意图与卡片动作

> 日期：2026-08-15
> 结论：✅ 完成。展示与交互两半都落地，`main/edit-review.ts` 与渲染层的专用组件已物理删除。

## 基线

开工前 `pnpm verify` 全绿（M3-a～M3-e 复审合入之后的 `ec80602`）。
本段完成后全量门禁重新通过，数字见文末。

## 交付

### 契约（`@xm/contracts`）

- 新增 `tool/card.ts`：`ToolCard` 四种闭集（`generic` / `terminal` / `diff` / `search`）、
  `CardAction`、`CardDiffFile`（`full` / `hunks` 两种形状）、`CARD_ACTION_PAYLOAD` 载荷闭集。
- 新增 `tool/origin.ts`：`ToolCallOrigin`。它是工具调用的属性，不是某条 payload 专属，
  所以没有塞进 `event/payloads.ts`。
- `ToolProgress.result` 新增 `presentation`；`tool.end` 新增 `presentation`；
  `tool.start` 新增 `origin`。
- **删除 `DisplayHint`**，连同 `PermissionRequest.preview` 与 `permission.request.preview`
  两个同样零生产者的字段（ADR-0039 删掉审批 UI 之后它们就没有消费者了）。

### 内核（`@xm/kernel`）

- `ToolSpec` 新增 `presentCall` / `presentResult` / `presentationSchema` / `actions`。
  四个都用 `NoInfer<I>` 包住，免得投影函数的形参参与入参类型推断。
- `defineTool` 把投影路径**软化**：入参解析失败、投影抛异常、产出形状不合契约，
  三步任一失败即返回 `undefined`。
- 新增 `tool/present.ts`：`projectCallCard` / `projectResultCard` **一定产出一张卡片**
  （降级落到通用卡片），以及 `projectSessionCards(state, tools)` 全量投影。
- `SessionState` 新增 `presentations`（按 `callId` 索引的落库展示事实），
  由 `reduce()` 从 `tool.end.presentation` 填，随快照序列化。

### 运行时（`@xm/runtime`）

- `turn-tools.ts` 把 `presentation` 过工具自己的 schema 后落 `tool.end`，
  把 `deps.callOrigins` 里的 `origin` 落 `tool.start`。
- 新增 `card-action.ts`：`runCardAction(deps, {callId, actionId, payload})`
  —— 反查工具 → 校验载荷 → `prepare` → **转成一次新的工具调用走完整十二步链**。
  最后一步复用 `runTurn` + 一个只念这一次调用的 Provider，不是"直接执行工具"的近路。

### 工具（`@xm/tools-core`）

- 新增 `edit-core.ts`（共用层）与 `edit-present.ts`（投影 + 两个动作）。
  拆 `edit-core` 不是为了好看：`edit.ts` 要用 `edit-present.ts` 的动作，
  而那些动作要用 `createEditProposal`，直接互相 import 就是一条循环依赖，
  depcruise 当场拦下（这条是实测出来的，不是预防性设计）。
- `edit.preview` 现在产出 `presentation`（每个文件的可审阅块）、diff 卡片、
  `accept` / `reject-all` 两个动作。收窄提案与两次漂移校验从
  `apps/desktop/src/main/edit-review.ts` **原样搬过来**，行为零改动。
- `EditProposalAccess` 新增 `markReviewed` 与 `get().reviewed`——落 `edit.reviewed` 的窄写入口。

### 桌面

- `readSession` 返回状态 + 全量卡片；`tool.start` / `tool.end` 推送时附带半张卡片。
- IPC 新增**一个**具名方法 `xm:card-action`，取代 `xm:review-edit-proposal`。
  preload 仍是具名转发，`preload-必须保持薄` 的实质没破。
- 渲染层新增 `lib/card-registry.ts`（注册表）与 `components/cards.tsx`（四种渲染器）。
  内建渲染器表的类型是 `Record<ToolCardKind, CardRenderer>`——**往闭集里加一种卡片却
  忘了画它，当场编译失败**，不用靠一条会被忘记更新的用例。
- `store.ts` 拆出 `cards-slice.ts`（体例对齐既有的 `orphaned-sessions.ts`）。
- **删除**：`main/edit-review.ts`、`renderer/components/diff-review-panel.tsx`、
  `renderer/lib/diff-review.ts`、`CH.reviewEditProposal` 及其请求/响应契约。

## 反向演练

每条都**先看它红一次**，再把护栏装回去确认转绿。

| # | 演练 | 摘掉什么 | 结果 |
|---|---|---|---|
| 1 | `presentCall` 读一次外部可变量（等价于读盘） | 把投影改成读一个中途被改的模块级变量 | `tool-present.test.ts` 的"两次投影逐字节一致"变红 |
| 2 | 真实尺寸旧库回放 | 摘掉 `defineTool` 里投影路径的软校验 | `card-replay-legacy.test.ts` 抛 `TypeError: Cannot read properties of undefined (reading 'split')` |
| 3 | 无渲染器降级 | `resetRenderers()` 后查四种种类 | 全部 `undefined`，触发摘要降级；空摘要卡片被契约拒收 |
| 4a | 未声明的 `actionId` | 摘掉 `runCardAction` 的 `action === undefined` 检查 | "工具没声明的 actionId：失败关闭"变红 |
| 4b | 伪造跨会话 `callId` | —（结构性：只查本会话状态） | 拒绝并报"不属于当前会话" |
| 5 | 动作载荷塞越界路径 | 摘掉 `claimForReview` 的"选择项必须属于这张卡片"检查 | "载荷里塞一个不属于这张卡片的选择项"变红 |
| 6 | `origin` 落库 | 摘掉 `tool.start` 里的 `origin` 展开 | "origin.kind = user-action 且回指那张卡片"变红 |

第 2 条按 `docs` 里"复审要用真实尺寸输入"的教训做：`card-replay-legacy.test.ts`
落一个**真的 SQLite 库**，写 2000 次工具调用（约 6000 条事件），
其中掺着旧版本字段名、被截断的碎片、类型对不上的入参、`null` 入参、
指向已卸载工具的调用、形状对不上当前 schema 的落库事实。全量投影一张都不许崩。

**第一版这条演练是假的**：夹具里的投影函数写成 `summary: input.path`，
在畸形入参上只会产出一张校验不过的卡片，永远走不到"投影抛异常"那条路——
摘掉软校验它照样绿。改成 `input.path.split('/')`（工具作者会自然写出来的形状）之后，
摘掉软校验才真的红。这正是"加一条护栏后必须先构造一个它真正要拦的场景"的用处。

### 另一处"规则存在但从未生效"

写第 5 条演练时，deny 层一开始写成 `composeRules({ env, user: { id, rules: [...] } })`。
`composeRules` 的 `user` 参数是**规则数组**，传对象时 `input.user.length > 0` 求值为
`undefined > 0` = false，整层被静默丢弃——测试因此在"没有任何 deny 规则"的情况下
断言"写入被拦下"，当然红。发现得早只是因为它红了；如果当时断言的是"允许"，
这条用例会以全绿的姿态什么也没测。

## M2-e 验收（ADR-0065 演练 5）

`main/edit-review.ts` 删除后，逐块接受/拒绝的全套语义由
`packages/runtime/tests/card-action.test.ts` 承接，**权限语义一个字没改**：

1. 只选一个 hunk → 生成收窄提案 → 真的落盘，其余改动一个字节不动；
2. 拒绝全部 → 落 `edit.reviewed`，零写入、零新调用；
3. 审阅期间文件漂移 → 零文件写入，动作以错误告终；
4. 越界路径的写入 → 被红线拦下，磁盘不变，`permission.decision` 记着是哪条规则拒的；
5. 同一张卡片点两次 → 第二次被拒，不会应用两遍。

第 4 条是这段的核心：**点了"接受"不等于批准了写入**。那次写入照常走网关规范化 →
红线判定 → 分层求值，被拒时连 `tool.start` 都不产生。

## 已知的取舍，写下来免得以后当 bug 查

1. **卡片上的按钮不会自己灰掉。** 卡片是入参与落库事实的纯投影，
   `presentResult` 看不到"这个提案后来被处理过了"。幂等性由主进程侧兜
   （`edit.reviewed` 落库后第二次动作被拒）。想让按钮自动灰掉就得让投影读会话状态，
   而那正是 ADR-0058 §三禁止的事。
2. **`presentations` 与卡片在 IPC 上有一份重复。** 渲染层其实只需要卡片，
   但 `SerializedSessionState` 必须与主进程那份形状完全一致（它要继续用 `reduce()`
   吃后续事件），所以落库事实也跟着过去一趟。数据量与 `editProposals` 同级，
   接受；真成问题时该做的是给 `presentations` 加压缩覆盖，不是让两侧状态形状分叉。
3. **`presentations` 目前不被上下文压缩覆盖**，与 `editProposals` 同一个形状的问题。
   长会话里它只增不减。M5 接定时任务/后台 job 之前应当一并处理。
4. **只有 `edit.preview` 一个工具写了投影。** 其余二十多个工具照旧走通用卡片降级，
   长相与 M3-f 之前完全一样。这是有意的：本段交付的是**机制**，
   给每个工具设计卡片是随后按真实痛点逐个加的事，不该在同一批里堆完。

## 门禁

`pnpm verify` 全绿：

- 单文件规模纪律：扫描 212 个文件，均在 400 行线内（**没有新增豁免**——
  `payloads.ts` / `reduce.ts` / `turn-tools.ts` / `store.ts` 四处超线全部靠拆分或压缩解决）
- 确定性边界：runtime/kernel 的时间与 ID 环境直调为零
- 测试：1225 passed | 10 skipped；kernel 覆盖率套件 736 passed
- depcruise：364 modules / 1457 dependencies，零违规
- headless 冒烟：170 条持久事件、237 条总线事件，与 M3-e 完全一致
- size-limit：8.7 kB / 15 kB

## 下一段

M3-g（扩展事件通道 + 不变量注册表 + 其余四张生成表进 `pnpm verify`）。
`docs/10 §9.5.1` 的形状已定案，尚未实现。
