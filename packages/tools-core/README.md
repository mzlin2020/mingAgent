# `@xm/tools-core`

Node 侧内建工具与能力网关：文件读写/列表、`search.text`、`web.fetch`、`shell.exec`、checkpoint 与受控 PTY。

M2-b 的 `search.text` 以 argv 方式执行 ripgrep JSON，路径仍经过能力网关并声明 `fs.read`；结果明确说明 ignore、二进制跳过、全局上限、中断和 ripgrep 缺失，不另开文件 I/O 旁路。

M1.5 不再暴露 `shell.session.write`。终端工具是 `open/run/status/resize/close`：`run` 只接受 argv，不经过 shell，复用 `shell.exec` 的命令主张、路径解析、环境白名单、红线、checkpoint 与超时。`status` 只返回状态、退出码和有界输出尾部。

M2-c checkpoint v2 把一次调用声明的文件、目录、大文件和多目标写入同一个结构化 manifest；恢复前完整校验 manifest 与内容 blob，多目标失败后可重试收敛。该包的策略保护不等于 OS 沙箱，详见 [ADR-0040](../../docs/adr/0040-M1.5自主安全边界与受控终端.md) 与 [ADR-0043](../../docs/adr/0043-M2-c-Checkpoint-v2与整组撤销.md)。

M2-d 提供 `edit.preview` / `edit.apply`：精确字符串命中、持久 unified diff、多路径网关主张、内容哈希漂移检测，以及由 M2-c 兜底的多文件故障恢复（ADR-0044）。

M2-f 提供 `git.status` / `git.diff` / `git.branch` / `git.commit`：全部使用无 shell argv、复用命令网关与策略链，返回结构化错误；diff 强制禁用 external diff/textconv，全部 Git 子进程关闭仓库级 fsmonitor hook；commit 强制显式 path-only 范围，默认不夹带其它文件的既有修改或暂存（ADR-0046）。

M2-g 提供 `search.symbol` / `search.indexed`：就绪时分别查询 tree-sitter WASM 符号与 FTS5 全文索引；冷启动、构建中、失败或过短查询自动复用 `search.text` 的 ripgrep 路径，不形成新的文件访问旁路（ADR-0047）。
