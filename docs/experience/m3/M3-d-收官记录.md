# M3-d 收官记录 · Agent 句柄与 Inbox

> 日期：2026-08-14
> 结论：✅ 完成；三入口、持久注入、易失队列与桌面纠偏入口均落地，`pnpm verify` 全绿。

## 交付

- `Agent` 提供 `followup` / `steer` / `inject`；`steer` 队列优先，两个队列内部 FIFO。
- 新增 persisted `context.injected`，来源闭集区分 plugin / subagent / job / cron / watcher。
- `reduce()` 把注入按 seq 投影成模型可见输入；与 `turn.start` 共用同一消息追加函数。
- `inject` 只落库，不激活空闲 Agent；未认领 followup/steer 只在内存，崩溃即丢失。
- steer 在步骤边界生效，不取消已经发起的工具；子 Agent 结论统一经父 Agent `inject` 回传。
- 桌面端运行中仍可排队发送，并提供“纠偏（下一步）”；UI 明示待处理队列为易失。
- headless 产物冒烟覆盖“空闲 inject 不唤醒、followup 显式唤醒、注入事件落库”。

## 反向演练

1. 注入后关闭并重开会话：内容只出现一次，位置由 seq 决定。
2. 空闲 Agent inject：drive 调用次数保持零。
3. followup ×2 与 steer ×2：认领顺序为 steer FIFO 后 followup FIFO。
4. 延迟工具执行途中 steer：工具正常产生 `tool.end`，纠偏的新 `turn.start` 排在其后。
5. 未认领 followup：事件库中无对应内容，也没有孤儿回合。
6. 携带 `net.fetch` 污点的注入：重放状态保留粘性不可信来源。

对应自动化：`packages/runtime/tests/agent-inbox.test.ts`、
`packages/kernel/tests/persistence-containment.test.ts` 与 `scripts/smoke-headless.mjs`。

## 门禁

- `pnpm verify`：通过。
- 112 个测试文件中 111 通过、1 个 live 组跳过；1213 个用例中 1190 通过、23 个跳过。
- depcruise、单文件规模、确定性边界、headless 产物冒烟和桌面四路 typecheck 全通过。
