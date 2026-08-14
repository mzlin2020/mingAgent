# M3-b · 装配迁移收官记录

日期：2026-08-14

## 1. 结论

M3-b 已完成。desktop 与 headless 现在都经 `@xm/compose` 的 profile → plugin catalog → `PluginContainer` 主链启动；原 `services.ts` 不再承担装配职责，桌面端剩余 surface 宿主改名为 `desktop-host.ts`。完整 `pnpm verify` 通过，M0–M2 的 headless 行为与事件数量未退化。

实现继续遵守本轮重构的参考边界：可借鉴 `C:\Users\EDY\Desktop\code_mine\deepseek-harness` 的容器/profile 思路，但保留小明自己的特权安全底座、二值权限语义与事件溯源不变量。

## 2. 交付

- 新增 `@xm/compose`：四份内建 profile、用户 config-dir patch、严格 schema、基线断言、装配诊断与脱敏配置导出。
- 新增 `@xm/tool-runtime`：从 `tools-core` 原样迁出 gateway/path/checkpoint 五个实现文件及 gateway 测试；经 Git 过滤后的 blob 哈希逐文件相同。
- desktop 使用 `desktop` profile；dist headless smoke 使用 `headless` profile；两者调用同一个 `assembleProfile()`。
- `SessionRuntime` 注入 `ClockService` / `IdService`，事件信封 ID、业务 ID、时间戳和耗时进入同一条确定性链。
- `--dump-config` 与根目录 `pnpm dump-config -- --profile <name> --config-dir <dir>` 输出最终 profile，统一经过 `redact()`。
- 新增生成式 [`M3-b-接缝图`](../../generated/M3-b-接缝图.md)，漂移检查进入 `pnpm verify`。
- 空工具 profile 的设置页显示“仍可对话与恢复会话”的明确提示。
- depcruise 固定 `compose`/Electron、compose 消费方向、tool-runtime/Electron 与 `tools-core → tool-runtime` 边界。

## 3. 确定性与安全验收

新增的迁移快照用同一输入分别运行“直接装配”和“test profile 装配”，对持久事件数组做 `JSON.stringify` 逐字节比较，并重复 profile 运行一次。比较没有删除或规范化任何字段，覆盖：

- `event.id`、session/turn/message/call ID；
- 所有 `ts`；
- `tool.end.durationMs`；
- 完整 payload 与事件顺序。

无业务行 profile 可独立装配，`tools` 基线服务仍存在且注册表为空；缺插件、元数据漂移、基线 patch、未知行、项目目录 patch 与业务插件冒充 `policy` 均有失败关闭用例。

## 4. 反向演练

1. 初次运行 compose 用例时包尚不存在，两组测试直接失败；实现后转绿。
2. 首次逐字节快照发现 `event.id` 仍走随机构造，测试准确红在每个事件信封；把 `ids.event()` 接入唯一记录出口后转绿。
3. 临时让 `tools-core` 相对 import `tool-runtime`，depcruise 命中专用规则 `tools-core-不得依赖-tool-runtime`；删除临时文件后恢复全绿。
4. 临时篡改生成接缝图，`generate-seam-map --check` 报过期；重新生成后恢复全绿。
5. patch 删除/替换基线、引用未知 ID、项目目录 patch、插件冒充基线服务等条件由持续单元测试固定。

## 5. 全量门禁证据

根目录 `pnpm verify`：

| 闸门 | 结果 |
|---|---|
| 工具链 / workflow / paths / 文件规模 / 供应链 | 全部通过；扫描 192 个生产文件 |
| 确定性边界 / 生成接缝图 | 全部通过；runtime/kernel 裸时间与 ID 调用为零 |
| 类型检查 / ESLint | 全部通过 |
| 全量测试 | 110 个测试文件：109 通过、1 跳过；1205 项：1182 通过、23 跳过 |
| Kernel 覆盖率 | 语句 92.56%、分支 83.94%、函数 97.05%、行 96.10% |
| Headless smoke | 通过；165 条持久事件、231 条总线事件，M2-b～M2-i 与安全红线链不变 |
| 写租约恢复 / 依赖边界 / size-limit | 全部通过；341 模块、1336 条依赖无违规；8.14 kB / 15 kB |

## 6. 阶段边界说明

ADR-0063 同时写明 local executor provider 在 M3-e 落地、物理删除 `tools-core` 的总验收排在 M3-e；旧版阶段表却把 `tools-core` 整包 `node:*` 禁令和物理删除编译提前到了 M3-b。两者无法同时成立：现有 fs/shell/pty 工具仍直接执行 Node I/O。

本次按已采纳 ADR 的依赖顺序收敛：M3-b 完成网关/checkpoint 拆包、无业务行启动与静态依赖方向；M3-e 建立 `ctx.executor` 后再启用 `tools-core` 整包 `node:*` 禁令，并做物理删除后的编译与启动演练。阶段文档已同步纠正，未用豁免伪装该约束已经生效。

## 7. 下一步

进入 M3-c：把 `turn.ts` 收敛为驱动器，建立五个回合级扩展点和工具执行十二步。继续沿用本段的逐字节事件快照，先固定旧行为，再搬 checkpoint、上下文构建、结果截断与上限兜底。
