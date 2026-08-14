# @xm/tool-runtime

工具执行的安全底座，当前包含路径/命令/主机网关、写前 checkpoint 与恢复，以及
M3-e 的 local `ExecutionWorld` provider（fs / process / pty）。

这些文件从 `@xm/tools-core` 原样迁出，公共签名与行为不变；基线 profile 通过 `@xm/tool-runtime#gateway` 和 `@xm/tool-runtime#checkpoint` 装配它们。业务工具仍留在 `@xm/tools-core`，且依赖方向只允许应用宿主同时认识两者，`tools-core` 不得反向依赖本包。

业务工具不 import 本包，也不直接 import `node:*`；它们只消费 `ctx.executor` 接缝。
local provider 是 H5 定案前唯一允许存在的执行世界实现，容器与远端 provider 尚未实现。
