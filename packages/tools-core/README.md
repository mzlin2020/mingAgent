# `@xm/tools-core`

Node 侧内建工具与能力网关：文件读写/列表、`search.text`、`web.fetch`、`shell.exec`、checkpoint 与受控 PTY。

M2-b 的 `search.text` 以 argv 方式执行 ripgrep JSON，路径仍经过能力网关并声明 `fs.read`；结果明确说明 ignore、二进制跳过、全局上限、中断和 ripgrep 缺失，不另开文件 I/O 旁路。

M1.5 不再暴露 `shell.session.write`。终端工具是 `open/run/status/resize/close`：`run` 只接受 argv，不经过 shell，复用 `shell.exec` 的命令主张、路径解析、环境白名单、红线、checkpoint 与超时。`status` 只返回状态、退出码和有界输出尾部。

checkpoint 对已存在文件失败关闭；目录和超大文件返回告警而不伪造 checkpoint。该包的策略保护不等于 OS 沙箱，详见 [ADR-0040](../../docs/adr/0040-M1.5自主安全边界与受控终端.md)。
