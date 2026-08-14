# M3-e 收官记录 · 能力接缝与执行世界

> 日期：2026-08-14
> 结论：✅ 完成；`ctx.executor`、local provider、业务工具零 `node:*` 与物理删包验收均落地。

## 基线

开工前 `pnpm verify` 唯一失败是生成式 M3-b 接缝图过期，脚本明确要求运行
`pnpm generate:seams`；不是产品代码或测试回归。本段完成后重新生成接缝图并跑全量门禁。

## 交付

- `@xm/kernel/src/port/execution-world.ts` 定义完整 `ExecutionWorld`：稳定能力描述，以及
  fs / process / pty 三组底层操作；`ToolContext.executor` 从字符串升级为真实接缝。
- `@xm/tool-runtime` 提供唯一生产实现 `localExecutionWorld`：原子文本写、流式文件读、
  无 shell argv 子进程、进程树终止、受控 PTY 与 Windows 可执行文件解析均收敛到 provider。
- desktop/headless profile 统一注册 `runtime.executor`；Turn、子 Agent、工具可用性判断均消费
  同一实例，不再按字符串猜执行环境。
- `@xm/tools-core` 的 fs / search / shell / git / edit / PTY 全部改经 `ctx.executor`；
  `node-pty` 随 local provider 迁到 `@xm/tool-runtime`。
- depcruise 新增整包规则 `tools-core-零-node内置`。它不维护文件名单，新增工具文件也自动受管。
- desktop 对 `@xm/tools-core` 改为 optional dependency + 动态可选边界；包缺席时删除 `tools.builtin` profile 行并启动
  空工具世界。`pnpm typecheck` / `pnpm smoke` 会按包是否存在选择正常或 no-tools 验收路径。
- H5 定案前没有实现 container / remote provider；测试用记录型假 provider 只用于接缝验收。

## 假 provider 验收

`packages/tools-core/tests/execution-world-seam.test.ts` 使用只记录调用、数据只存内存的 provider：

1. `fs.read` / `fs.list` / `fs.write`、三种搜索入口、`shell.exec` 与四个 Git 工具全部跑通；
2. `edit.preview` / `edit.apply` 的读取、散列和原子写全部落到假 fs；
3. PTY open / run / status / resize / close 共用假 pty；
4. 测试过程不产生真实文件、子进程或 PTY 副作用；
5. 工具收到的已判定路径原样交给 provider，工具不调用 `realpath` 二次解析；普通读写结果的
   类型没有回传替换路径的字段，假 provider 试图返回另一条路径会在编译期被拒绝。

## 反向演练

1. 临时在 `packages/tools-core/src/fs-read.ts` 加入 `node:fs` import：`pnpm depcruise` 变红，
   并点名 `tools-core-零-node内置`；删除攻击样本后恢复全绿。
2. 记录型 provider 下执行全部 fs/process/pty 工具：只有内存记录变化，真实世界零副作用。
3. provider 路径替换预演：操作结果结构不接受 `{ path, bytes }`，且工具不调用 provider 的
   `realpath` 重解析已回写路径；两道约束分别由类型测试和调用记录断言固定。
4. 将 `packages/tools-core` 临时移到 `packages/*` 工作区通配符之外，使工作区项目数从 11
   变成 10、原路径物理不存在；在该窗口内：
   - `pnpm typecheck` 通过，核心、运行时、desktop main/renderer 均完成类型检查；
   - `pnpm smoke` 通过，空工具 headless profile 完成一轮对话，写租约恢复冒烟仍绿；
   - 演练结束后目录原位恢复。

## 门禁

- `pnpm typecheck`、`pnpm lint`、定向执行世界/desktop/profile 用例、depcruise、单文件规模检查通过。
- `pnpm smoke` 的完整工具世界与 no-tools 物理删包路径均通过。
- `pnpm verify`：通过。112 个测试文件中 111 通过、1 个 live 组跳过；1210 个用例中
  1187 通过、23 个跳过。kernel coverage 57 个文件、711 个用例全绿。
- depcruise 扫描 355 个模块 / 1405 条依赖零违规；单文件规模、确定性边界、接缝图漂移、
  headless 产物冒烟、写租约恢复与 size-limit 全通过。
