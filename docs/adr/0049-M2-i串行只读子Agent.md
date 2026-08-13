# ADR-0049 · M2-i 串行、有限、只读的隔离子 Agent

- **状态**：🟢 Accepted
- **日期**：2026-08-13
- **相关**：[ADR-0008](./0008-事件持久化分层与演进.md)、[ADR-0033](./0033-G2闸门-MCP工具与子Agent的污点传播.md)、[ADR-0048](./0048-M2-h上下文预算与持久摘要.md)

## 背景

契约已有 `subagent.start` / `subagent.end`，存储投影也支持 `parentSessionId`，但
`SessionRuntime.record()` 仍按 ADR-0033 失败关闭。M2-i 要让主循环能够委派只读探索，同时不能
把独立上下文变成写能力、任意代码执行或注入防御旁路。

## 决策

### 1. 唯一入口是 `agent.explore`

主模型通过内建 `agent.explore { purpose, maxTurns, timeoutMs }` 派生。工具本身只负责会话内编排，
声明空能力并登记本 ADR；真正的文件/网络访问仍由子 Agent 的具体工具逐次声明能力、经过网关与
策略。工具为 `exclusive`，主 Turn 原本也串行分发调用，因此 M2 不引入并行派生。

### 2. 子注册表是 builtin 名称白名单，不按“看起来只读”猜

子 Agent 只复制父注册表中来源为 builtin 且名称属于以下集合的工具：文件列表/读取、文本/符号/
FTS 搜索、网页读取、Git status/diff。`agent.explore` 自身、edit、commit、shell、PTY、todo、插件、
MCP 与任何未知零能力工具都不进入子描述符。手工构造未注册工具调用仍在 `dispatchCall` 失败。
用户规则只能进一步收紧，不能把缺失工具加回来。

### 3. 父子事件与上下文物理隔离

每次派生创建新的 `agentId`、`childSessionId` 和 `SessionRuntime`。子 `session.created` 记录
`parentSessionId` / `parentCallId`，拥有从 1 开始的独立 seq；父事件流只有 start/end 与触发工具的
最终结论。子完整消息、工具调用和 ContextBuilder 预算只存在于子事件流。

### 4. 有界生命周期

`maxTurns` 限定 1–8 次模型往返，`timeoutMs` 限定 1–120 秒。父 AbortSignal 与本地 timeout 合并
后传入子 `runTurn`；正常完成、迭代耗尽、Provider 失败、父取消和超时都在 `finally` 路径记录
`subagent.end`。应用重启时，父状态中仍 running 的派生从子事件重建末态并补一条
`reason: interrupted` 的 end，父会话不会永久等待。

### 5. ADR-0033 闸门由真实污点合并替换

`subagent.end` 可选携带子末态 `untrustedContext` 的来源四元组。父 reducer 在自己尚未带污点时
原样接收；父已有污点时保留更早来源，保持“置上后只由用户显式清除”的既有语义。生产者先读
子末态再写 end；重启补偿路径也做同样的重建。原来的 `UnimplementedSubagentTaintPropagationError`
和 record 闸门删除。

### 6. 只回传结论

成功时取子会话最后一条 assistant 文本作为 `subagent.end.summary` 和父工具结果；失败时回传一条
有界的原因说明。图片、完整 transcript、工具原始结果和子 ContextBuilder 摘要不复制到父上下文。

## 后果

- 独立 session/seq 是存储事实，不是提示词约定；子轨迹仍可单独诊断。
- 名称白名单有维护成本；新增只读 builtin 不会自动进入子 Agent，必须显式评审后加入。
- M2 不支持并行、递归、写工具、第三方插件/MCP、shell 或后台无人值守；这些需求分别留给后续
  沙箱、插件与调度里程碑。
