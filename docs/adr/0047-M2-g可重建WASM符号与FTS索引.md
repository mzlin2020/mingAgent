# ADR-0047 · M2-g 可重建 WASM 符号与 FTS 索引

- **状态**：Accepted
- **日期**：2026-08-13
- **相关**：[ADR-0013](./0013-存储引擎选型与EventStore端口.md)、[ADR-0016](./0016-原生模块与打包.md)、[ADR-0042](./0042-M2-b文本检索与会话内结果展开.md)、[M2 阶段划分](../M2-阶段划分.md)

## 背景

M2-b 的 ripgrep 是可靠的即时基线，但不了解语法结构，也不会保存全文召回索引。M2-g 需要
tree-sitter 符号与 SQLite FTS5，同时不能让索引冷启动、损坏或三平台二进制差异阻断基本搜索。
原生 tree-sitter 绑定还会触发 ADR-0016 的重新评估条件，重新引入 Node/Electron ABI 与三平台
重编矩阵。

## 决策

### 1. tree-sitter 只走同一套 WASM

使用 `web-tree-sitter` 运行时和 `@vscode/tree-sitter-wasm` 的预编译 grammar 资产。Node、
Electron、Windows、macOS、Linux 加载相同 `.wasm` 字节，不新增 `.node`、安装脚本或
`electron-rebuild`。首批语言是仓库自身可真实验收的 TypeScript / TSX / JavaScript / JSX；
其它文本仍进入 FTS，符号查询明确标记为不支持，而不是用正则冒充语法解析。

### 2. 索引是单独的可删除派生库

索引落在平台数据目录的 `workspace-index.sqlite`，按规范化工作区身份隔离，不进入用户仓库，
也不写事件真相库。数据库保存文件指纹、FTS5 trigram 全文和 tree-sitter 符号。损坏、版本不符、
上次停在 building 或显式重建时都可整库重建；删除索引不丢任何用户事实。

### 3. 按需启动，增量提交

打开/创建工作区后只后台触发一次 refresh，不阻塞会话。refresh 递归扫描受支持的普通文本，
忽略 `.git`、依赖与构建目录；mtime、大小均未变化的文件跳过。每个变化文件的全文和符号在
同一事务内替换，扫描结束再删除不再存在的路径，因此修改、删除和重命名都收敛。取消会留下
`stale`，下一次可续建，不把半成品标成 ready。

### 4. 查询永远有 M2-b 退路

新增 `search.symbol` 与 `search.indexed`。索引 ready 时前者查符号、后者查 FTS；冷启动、构建中、
损坏、短查询或运行时错误时，工具立即调用与 `search.text` 相同的 ripgrep 实现并在结果中标明
`source: ripgrep-fallback`，同时后台触发 refresh。索引只是加速和结构增强，不能成为可用性的
前置条件。

## 后果

- 正面：三平台解析能力字节级一致，不改变原生模块发布策略。
- 正面：索引损坏、取消或未完成不会阻断查询；用户仓库保持零索引文件。
- 正面：增量更新与删除/重命名通过单一派生库事务收敛。
- 代价：WASM 比原生绑定慢；M2-g 选择启动安全与发布一致性，不追求最大解析吞吐。
- 代价：首批结构化符号语言范围明确受限，其它语言只有全文与 ripgrep fallback。
