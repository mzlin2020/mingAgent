# M3-b profile 接缝图

> 本文件由 `node scripts/generate-seam-map.mjs` 生成；请勿手工编辑。

四个内建 profile 均经 `@xm/compose` 的同一条装配路径启动。`baseline.*` 是不可被用户 patch 替换、删除或插队的特权基线。

| profile | 层级 | 行 ID | 插件引用 | 注入服务 | 提供服务 |
|---|---|---|---|---|---|
| `desktop` | 特权基线 | `baseline.clock` | `@xm/platform#localClock` | — | `clock` |
| `desktop` | 特权基线 | `baseline.ids` | `@xm/platform#localIds` | — | `ids` |
| `desktop` | 特权基线 | `baseline.turn-driver` | `@xm/runtime#turnDriver` | — | `turnExtensions` |
| `desktop` | 特权基线 | `baseline.policy` | `@xm/kernel#policy` | — | `policy` |
| `desktop` | 特权基线 | `baseline.gateway` | `@xm/tool-runtime#gateway` | — | `gateway` |
| `desktop` | 特权基线 | `baseline.checkpoint` | `@xm/tool-runtime#checkpoint` | `turnExtensions` | `checkpointer`<br>`checkpointRestorer` |
| `desktop` | 特权基线 | `baseline.secrets` | `@xm/platform#secrets` | — | `secrets` |
| `desktop` | 特权基线 | `baseline.redact` | `@xm/contracts#redact` | — | `redact` |
| `desktop` | 特权基线 | `baseline.tools` | `@xm/kernel#toolRegistry` | — | `tools` |
| `desktop` | 特权基线 | `baseline.runtime` | `@xm/runtime#sessionRuntime` | `clock`<br>`ids`<br>`policy`<br>`gateway`<br>`checkpointer`<br>`secrets`<br>`redact`<br>`tools` | `runtime` |
| `desktop` | 业务 | `runtime.executor` | `@xm/tool-runtime#localExecutor` | — | `executor` |
| `desktop` | 业务 | `runtime.multimodal` | `@xm/runtime#multimodalGuard` | `turnExtensions` | — |
| `desktop` | 业务 | `runtime.context` | `@xm/runtime#contextBuilder` | `turnExtensions` | — |
| `desktop` | 业务 | `runtime.result-truncation` | `@xm/runtime#resultTruncation` | `turnExtensions` | — |
| `desktop` | 业务 | `runtime.stopping` | `@xm/runtime#stoppingGuard` | `turnExtensions` | — |
| `desktop` | 业务 | `tools.builtin` | `@xm/tools-core#builtinTools` | `runtime`<br>`tools`<br>`gateway`<br>`checkpointer`<br>`executor` | — |
| `desktop` | 业务 | `surface.desktop` | `@xm/desktop#desktopSurface` | `runtime`<br>`tools` | `surface` |
| `headless` | 特权基线 | `baseline.clock` | `@xm/platform#localClock` | — | `clock` |
| `headless` | 特权基线 | `baseline.ids` | `@xm/platform#localIds` | — | `ids` |
| `headless` | 特权基线 | `baseline.turn-driver` | `@xm/runtime#turnDriver` | — | `turnExtensions` |
| `headless` | 特权基线 | `baseline.policy` | `@xm/kernel#policy` | — | `policy` |
| `headless` | 特权基线 | `baseline.gateway` | `@xm/tool-runtime#gateway` | — | `gateway` |
| `headless` | 特权基线 | `baseline.checkpoint` | `@xm/tool-runtime#checkpoint` | `turnExtensions` | `checkpointer`<br>`checkpointRestorer` |
| `headless` | 特权基线 | `baseline.secrets` | `@xm/platform#secrets` | — | `secrets` |
| `headless` | 特权基线 | `baseline.redact` | `@xm/contracts#redact` | — | `redact` |
| `headless` | 特权基线 | `baseline.tools` | `@xm/kernel#toolRegistry` | — | `tools` |
| `headless` | 特权基线 | `baseline.runtime` | `@xm/runtime#sessionRuntime` | `clock`<br>`ids`<br>`policy`<br>`gateway`<br>`checkpointer`<br>`secrets`<br>`redact`<br>`tools` | `runtime` |
| `headless` | 业务 | `runtime.executor` | `@xm/tool-runtime#localExecutor` | — | `executor` |
| `headless` | 业务 | `runtime.multimodal` | `@xm/runtime#multimodalGuard` | `turnExtensions` | — |
| `headless` | 业务 | `runtime.context` | `@xm/runtime#contextBuilder` | `turnExtensions` | — |
| `headless` | 业务 | `runtime.result-truncation` | `@xm/runtime#resultTruncation` | `turnExtensions` | — |
| `headless` | 业务 | `runtime.stopping` | `@xm/runtime#stoppingGuard` | `turnExtensions` | — |
| `headless` | 业务 | `tools.builtin` | `@xm/tools-core#builtinTools` | `runtime`<br>`tools`<br>`gateway`<br>`checkpointer`<br>`executor` | — |
| `headless` | 业务 | `surface.headless` | `@xm/compose#headlessSurface` | `runtime`<br>`tools` | `surface` |
| `cli` | 特权基线 | `baseline.clock` | `@xm/platform#localClock` | — | `clock` |
| `cli` | 特权基线 | `baseline.ids` | `@xm/platform#localIds` | — | `ids` |
| `cli` | 特权基线 | `baseline.turn-driver` | `@xm/runtime#turnDriver` | — | `turnExtensions` |
| `cli` | 特权基线 | `baseline.policy` | `@xm/kernel#policy` | — | `policy` |
| `cli` | 特权基线 | `baseline.gateway` | `@xm/tool-runtime#gateway` | — | `gateway` |
| `cli` | 特权基线 | `baseline.checkpoint` | `@xm/tool-runtime#checkpoint` | `turnExtensions` | `checkpointer`<br>`checkpointRestorer` |
| `cli` | 特权基线 | `baseline.secrets` | `@xm/platform#secrets` | — | `secrets` |
| `cli` | 特权基线 | `baseline.redact` | `@xm/contracts#redact` | — | `redact` |
| `cli` | 特权基线 | `baseline.tools` | `@xm/kernel#toolRegistry` | — | `tools` |
| `cli` | 特权基线 | `baseline.runtime` | `@xm/runtime#sessionRuntime` | `clock`<br>`ids`<br>`policy`<br>`gateway`<br>`checkpointer`<br>`secrets`<br>`redact`<br>`tools` | `runtime` |
| `cli` | 业务 | `runtime.executor` | `@xm/tool-runtime#localExecutor` | — | `executor` |
| `cli` | 业务 | `runtime.multimodal` | `@xm/runtime#multimodalGuard` | `turnExtensions` | — |
| `cli` | 业务 | `runtime.context` | `@xm/runtime#contextBuilder` | `turnExtensions` | — |
| `cli` | 业务 | `runtime.result-truncation` | `@xm/runtime#resultTruncation` | `turnExtensions` | — |
| `cli` | 业务 | `runtime.stopping` | `@xm/runtime#stoppingGuard` | `turnExtensions` | — |
| `cli` | 业务 | `tools.builtin` | `@xm/tools-core#builtinTools` | `runtime`<br>`tools`<br>`gateway`<br>`checkpointer`<br>`executor` | — |
| `cli` | 业务 | `surface.cli` | `@xm/compose#cliSurface` | `runtime`<br>`tools` | `surface` |
| `test` | 特权基线 | `baseline.clock` | `@xm/kernel#deterministicClock` | — | `clock` |
| `test` | 特权基线 | `baseline.ids` | `@xm/kernel#deterministicIds` | — | `ids` |
| `test` | 特权基线 | `baseline.turn-driver` | `@xm/runtime#turnDriver` | — | `turnExtensions` |
| `test` | 特权基线 | `baseline.policy` | `@xm/kernel#policy` | — | `policy` |
| `test` | 特权基线 | `baseline.gateway` | `@xm/tool-runtime#gateway` | — | `gateway` |
| `test` | 特权基线 | `baseline.checkpoint` | `@xm/tool-runtime#checkpoint` | `turnExtensions` | `checkpointer`<br>`checkpointRestorer` |
| `test` | 特权基线 | `baseline.secrets` | `@xm/platform#secrets` | — | `secrets` |
| `test` | 特权基线 | `baseline.redact` | `@xm/contracts#redact` | — | `redact` |
| `test` | 特权基线 | `baseline.tools` | `@xm/kernel#toolRegistry` | — | `tools` |
| `test` | 特权基线 | `baseline.runtime` | `@xm/runtime#sessionRuntime` | `clock`<br>`ids`<br>`policy`<br>`gateway`<br>`checkpointer`<br>`secrets`<br>`redact`<br>`tools` | `runtime` |
| `test` | 业务 | `runtime.executor` | `@xm/tool-runtime#localExecutor` | — | `executor` |
| `test` | 业务 | `runtime.multimodal` | `@xm/runtime#multimodalGuard` | `turnExtensions` | — |
| `test` | 业务 | `runtime.context` | `@xm/runtime#contextBuilder` | `turnExtensions` | — |
| `test` | 业务 | `runtime.result-truncation` | `@xm/runtime#resultTruncation` | `turnExtensions` | — |
| `test` | 业务 | `runtime.stopping` | `@xm/runtime#stoppingGuard` | `turnExtensions` | — |
| `test` | 业务 | `tools.builtin` | `@xm/tools-core#builtinTools` | `runtime`<br>`tools`<br>`gateway`<br>`checkpointer`<br>`executor` | — |
| `test` | 业务 | `surface.test` | `@xm/compose#testSurface` | `runtime`<br>`tools` | `surface` |

## 固定边界

- `desktop` 与 `headless` 使用本机 clock/ID provider；`test` 使用确定性 provider。
- `gateway` 与 `checkpoint` 实现位于 `@xm/tool-runtime`；`@xm/tools-core` 只保留业务工具。
- 用户 patch 只从显式的用户 `configDir/profiles/<name>.patch.json` 读取。
- `--dump-config` 输出在写往 stdout 前统一经过脱敏。
