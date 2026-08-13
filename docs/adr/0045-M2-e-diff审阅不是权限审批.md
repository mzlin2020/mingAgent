# ADR-0045 · M2-e diff 审阅不是权限审批

- **状态**：Accepted
- **日期**：2026-08-12
- **相关**：[ADR-0039](./0039-放弃审批模式.md)、[ADR-0044](./0044-M2-d精确编辑与多文件事务.md)、[M2 阶段划分](../M2-阶段划分.md)

## 背景

M2-d 已把 unified diff 和内容哈希保存为 `EditProposal`。桌面端需要让用户查看并选择改动块，
但 ADR-0039 已删除 `ask`、审批卡片和会话授权；若把 diff 面板重新接成“允许/拒绝工具执行”，
会恢复第二套权限系统，并让模型再次挂起等人。

## 决策

### 1. 审阅改变的是提案内容，不是权限 verdict

模型仍可自主调用 `edit.preview` 后直接 `edit.apply`，不等待用户；这是默认的自动应用语义。
桌面端只展示事件投影里尚未 applied/reviewed 的持久提案。用户选择块时，主进程把选择记录为
`edit.reviewed`，并从选中的精确替换生成一个新的、收窄后的 `EditProposal`。选择为空等于拒绝
全部：只写审阅事件，磁盘不变。

不存在 `allow`、`ask`、临时授权或“审阅后跳过策略”的状态。非空选择的实际落盘仍通过
M2-d `edit.apply` 的完整工具分发路径，照常做路径网关、`allow | deny` 判定、整组 checkpoint
与内容漂移检测。

### 2. hunk 是提案中的稳定结构，不由 renderer 解析 diff 猜

`EditProposalFile` 可选携带 `hunks`；M2-e 生成的提案都写入它。每个 hunk 有稳定 ID、对应的
replacement 索引和可直接展示的 unified diff。renderer 只保存勾选、展开和滚动等瞬态视图态，
不从 diff 文本反推要应用什么，也不维护第二份提案生命周期。

### 3. 用户应用选择是一条可回放的本地 turn

主进程收到窄 IPC `{sessionId, proposalId, selectedHunkIds}` 后，再次确认原提案仍待审、hunk ID
都属于它、文件 beforeHash 仍一致。选中内容先成为新的 `edit.proposed`，然后以 scripted provider
构造一次明确的本地用户 turn，调用生产注册表中的 `edit.apply`。这样不新增绕过分发器的写入口，
审计里也能看到这次改变由用户在 diff 面板发起。

### 4. 大 diff 有界渲染

面板一次只挂载当前文件的 hunk，单个 hunk 展示最多 400 行；超出部分显示省略提示，完整 diff
仍留在持久提案中。文件列表与 hunk 勾选不要求把整个仓库 diff 同时塞进 DOM。

## 后果

- 正面：逐块审阅复用 M2-d 的安全与恢复路径，不恢复 ADR-0039 删除的审批状态机。
- 正面：刷新、切会话和重启只会丢失勾选视图态，不会把 pending 提案误记为 applied。
- 代价：非空选择会产生一个派生提案和一条本地 turn，事件比“直接改文件”多，但事实来源清晰。
- 代价：依赖前一替换结果的 hunk 不能任意拆开；选中组合若无法独立满足精确命中条件会显式失败。
