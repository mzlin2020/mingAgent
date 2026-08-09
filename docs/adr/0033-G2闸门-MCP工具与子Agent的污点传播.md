# ADR-0033 · G2 闸门：MCP 工具与子 Agent 的污点传播

- **状态**：🟢 Accepted
- **日期**：2026-08-09
- **相关**：[docs/09 §G2](../09-待讨论的开放问题.md)；先例 [ADR-0020](./0020-非路径target的规范化契约.md)
  决策三/四（命令行 target 的"M1-a 只落一道失败关闭的闸门"）、[ADR-0026](./0026-命令的主张分解与argv契约.md)
  （闸门被真实实现替换的历史先例）、[ADR-0032](./0032-地基复审三-M1收尾前的原则符合度审查.md) #5
  （`EMPTY_CAPABILITIES_ALLOWLIST`，同一手法在工具注册路径上的先例）

## 背景

`taintOf()`（`packages/kernel/src/state/reduce.ts`）从 `tool.start.capabilities` 判定
`untrustedContext`，覆盖不了两条路（`UNTRUSTED_CONTENT_CAPABILITIES` 的注释里已经写明，
`packages/contracts/src/permission/capability.ts`）：

- **MCP 工具**：`ToolDescriptor.source.kind === 'mcp'`（`contracts/tool/descriptor.ts`）早就
  存在，但没有任何逻辑读它。若一个 MCP server 不如实声明 `net.fetch`，它拉回来的外部内容
  不会被标记为不可信——而 MCP server 是第三方的，声明是否如实完全不受我们控制。
- **子 Agent**：子会话有独立 `sessionId` 与独立事件流（ADR-0008 决策五），父会话 `reduce()`
  读不到子会话的 `tool.start`，子会话里标出的 `untrustedContext` 不会传染回父会话。派一个
  子 Agent 去读网页，是当前设计下完整的注入防御绕过路径。

M1 既没有 MCP 客户端也没有子 Agent 派生机制——没有载体就无法用真实输入验证任何一种实现。
`trustLevel` 硬编码（ADR-0017）与 Windows 8.3 短文件名（ADR-0018）两次翻车都是这个形状：
写了实现、测试全绿、真实输入下从未跑过。

## 选项

### 选项 A：现在就实现真正的污点传播

MCP 侧：注册时若 `source.kind === 'mcp'` 就无条件标记该工具为不可信源。子 Agent 侧：
`subagent.end` 时把子会话末态的 `untrustedContext` 并回父会话。

优点：功能完整。
缺点：没有真实的 MCP client / 子 Agent 派生代码，这段逻辑只能靠手工构造的事件驱动测试，
和 `trustLevel`/8.3 短名同一个失败模式——测试全绿、真实输入下从未跑过。

### 选项 B：只落一道失败关闭的闸门，实现随载体走

在注册 MCP 工具、记录 `subagent.start`/`subagent.end` 的路径上直接失败关闭，把契约在本 ADR
里定死；等 M2（子 Agent）/M3（MCP）真正的载体落地时，再实现闸门背后的逻辑，并删除闸门本身。

优点：不产生"看起来实现了、其实没测过"的假象；手法与 ADR-0020 决策三完全一致，是本项目
已验证过的模式。
缺点：MCP 工具与子 Agent 在闸门解除之前完全不可用——但 M1 本来就不需要用到它们。

## 决策

选择**选项 B**。

### 契约（定死，实现随载体走）

1. **MCP 工具默认按不可信内容源处理**（宁可误标，不可漏标）。落地时（M3）的形状：`taintOf()`
   对 `source.kind === 'mcp'` 的工具产出的 `tool.start` 无条件置上 `untrustedContext`，**不**
   依赖该工具声明了哪些 `capabilities`。
2. **子 Agent 的污点在 `subagent.end` 时并回父会话**。落地时（M2）的形状：产生 `subagent.end`
   的一方读取子会话末态的 `untrustedContext`，若非空则让父会话的 `reduce()` 对等地置上自己的
   `untrustedContext`（沿用同一个粘性语义——一旦置上不因单次事件清除）。
3. **在以上两条真正实现之前**：
   - `ToolRegistry.register()`（`packages/kernel/src/tool/registry.ts`）拒绝任何
     `source.kind === 'mcp'` 的 `RegisteredTool`，抛 `UnimplementedMcpTaintPropagationError`。
     放在 `register()` 而不是 `defineTool()`：后者只覆盖手写 `ToolSpec` 这一条构造路径，
     而 `register()` 是任何工具（内置/插件/未来 MCP，不管怎么构造出来的 `RegisteredTool`）
     最终都必须经过的唯一入口。
   - `SessionRuntime.record()`（`packages/runtime/src/session-runtime.ts`）拒绝记录
     `subagent.start` / `subagent.end`，抛 `UnimplementedSubagentTaintPropagationError`。
     刻意不放进 `reduce()`：`reduce()` 要对它声明过的整个事件词表保持"全"，已有测试
     （`persistence-containment.test.ts`/`snapshot.test.ts`）拿合法的这两种事件驱动它验证
     无关断言（持久化包含性、快照往返），在 `reduce()` 里抛错会连累它们。`record()` 是
     全系统唯一分配 `seq` 的写入边界，任何未来代码想让这两种事件落库，绕不开这里——
     `reduce()` 的读侧全（total）与 `record()` 的写侧闸门是两件不同的事。

### 生命周期（与 ADR-0020 → ADR-0026 相同）

闸门不是永久代码。M2 落地子 Agent 派生路径时，实现 `subagent.end` 的污点合并并删除
`record()` 里的那道检查；M3 落地 MCP 客户端时，实现 `taintOf()` 对 `source.kind==='mcp'` 的
无条件标记并删除 `register()` 里的那道检查。闸门存在期间没有任何合法方式绕过它——这正是
"注册时/记录时就炸"要保证的事。

## 后果

- 正面：在没有真实载体之前，注入防御上"唯一剩下的绕过路径"（docs/09 G2）被结构性地堵死，
  而不是靠没人记得去滥用来维持。
- 正面：`ToolDescriptor.source`（ADR-0032 #6 已确认的挂钩点）、`SubagentStartPayload`/
  `SubagentEndPayload`（M0-b 就已存在）都不需要任何契约变更——`event/registry.ts` 不升版本，
  不需要 upcaster。
- 负面：MCP 工具与子 Agent 在 M1 完全不可注册/不可派生——但两者都不是 M1 的交付项，
  不算新增限制。
- 需要接受的代价与缓解措施：闸门本身不会被 CI 自动"忘记删除"——`packages/kernel/tests/
  tool-registry.test.ts` 与 `packages/runtime/tests/subagent-gate.test.ts` 有明确断言
  "builtin/plugin 来源不受影响"，落地真实实现时这些断言会随闸门一起被替换，不是被绕过。
- 什么条件下应该重新评估：若 M2 子 Agent 或 M3 MCP 的真实落地发现子会话污点的语义比"粘性
  布尔 + 并回"更复杂（比如需要区分污点来源以做更细粒度的降级），需要单独出一份 ADR，
  不能在实现闸门背后逻辑时顺手改写契约。
