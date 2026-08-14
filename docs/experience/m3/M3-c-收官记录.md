# M3-c 收官记录 · 驱动器扩展点化

> 日期：2026-08-14
> 结论：✅ 完成；M3-b 的确定性事件流快照保持逐字节一致，`pnpm verify` 全绿。

## 交付

- `turn.ts` 收敛为不足 200 行的特权驱动器；流读取、工具链与行为插件拆到独立模块。
- 落地五个回合级命名扩展点和 `tool/pre-execute`、`tool/execute`、
  `tool/post-execute`、`tool/result` 四个工具级扩展点。
- ContextBuilder、多模态 admission、checkpoint、结果截断、`maxIterations` 与连续
  `max_tokens` 兜底均由 profile 插件装配。
- 工具链保持十二步固定顺序，特权链段仍不可插入、重排或改写。
- 真实工具体执行签发进程内 `ExecutionReceipt`；短路插件无法伪造成功审计。

## 反向演练

1. pre-execute 监听器在红线 deny 后返回 allow：运行时单调性检查拒绝，工具执行次数为零。
2. execute 监听器跳过 `next()` 返回伪成功：因无真实收据按失败结束，且没有 `tool.start`。
3. pre-execute 强改已规范化路径：深冻结输入当场拒绝，判定/执行不能分叉。
4. 确定性 profile 的迁移前后快照仍逐字节一致，`durationMs` 未因收据增加时钟读取而漂移。

对应自动化：`packages/runtime/tests/turn-extensions.test.ts`、
`packages/compose/tests/deterministic-runtime.test.ts`。

## 门禁

- `pnpm verify`：通过。
- 112 个测试文件中 111 通过、1 个 live 组跳过；1213 个用例中 1190 通过、23 个跳过。
- depcruise：352 个模块、1386 条依赖，零违规。
- 单文件规模、确定性边界、headless 产物冒烟与写租约 SIGKILL 恢复均通过。
