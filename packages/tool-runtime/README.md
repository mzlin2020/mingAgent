# @xm/tool-runtime

工具执行的安全底座，当前包含路径/命令/主机网关以及写前 checkpoint 与恢复实现。

这些文件从 `@xm/tools-core` 原样迁出，公共签名与行为不变；基线 profile 通过 `@xm/tool-runtime#gateway` 和 `@xm/tool-runtime#checkpoint` 装配它们。业务工具仍留在 `@xm/tools-core`，且依赖方向只允许应用宿主同时认识两者，`tools-core` 不得反向依赖本包。

M3-e 执行世界接缝完成后，本包还会承载 local executor provider；在此之前不提前搬动具体工具的 Node I/O 行为。
