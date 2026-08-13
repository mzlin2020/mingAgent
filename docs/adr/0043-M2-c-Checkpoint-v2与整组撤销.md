# ADR-0043 · M2-c Checkpoint v2 与整组撤销

- **状态**：Accepted
- **日期**：2026-08-12
- **相关**：[ADR-0013](./0013-存储引擎选型与EventStore端口.md)、[ADR-0024](./0024-路径能力网关.md)、[ADR-0040](./0040-M1.5自主安全边界与受控终端.md)、[M2 阶段划分](../M2-阶段划分.md)

## 背景

M1.5 的 checkpoint 只有一个逗号拼接的 `ref` 字符串。它能保存一次调用涉及的几个小文件，
但不知道每个 blob 属于哪个路径，也不能可靠区分“文件原本不存在”与“原本是空文件”。目录和
超过 8 MiB 的文件只告警后继续，更没有列表、详情或恢复实现。这个格式不足以兑现 M2-c 的整组撤销，
也不能作为 Blob GC 的可达性依据。

受控 `shell.exec` 与 `shell.session.run` 已经把声明的写入/删除目标归一化为具体
`fs.write` / `fs.delete` claim。Checkpoint v2 继续只消费这份主张，不另建命令名单，
也不承诺恢复命令没有声明的第三方副作用。

## 决策

### 1. 一次调用只产生一个 checkpoint 集合

运行时在工具执行前收集本次调用的全部文件写入/删除 claim，去重并消除被父目录覆盖的子目标，
然后完成整组快照。只有所有目标都能恢复时才写入一条 `checkpoint.created`；任何读取、遍历或
Blob 落盘失败都停止工具调用，并且不产生伪 checkpoint。

`checkpoint.created` 可选增加触发它的 `callId` 与 `manifestRef`。老事件仍保留 v1 的 `ref`；
新事件同时保留人类可读的 `label`，但恢复只读结构化 manifest，不解析 label 或逗号字符串。

### 2. manifest 是内容寻址的恢复计划

每个 v2 checkpoint 有一份 UTF-8 JSON manifest，以
`application/vnd.xm.checkpoint-manifest+json` 存入 BlobStore。格式带显式 `version: 2`，
并按规范化绝对目标路径排序。每个目标记录快照前状态：

- `missing`：目标原本不存在，恢复时删除当前目标；
- `file`：记录文件内容的 `BlobRef`；
- `directory`：记录扁平、按相对路径排序的目录项；普通文件引用内容 blob，空目录保留目录项，
  符号链接只记录链接文本并且遍历时不跟随。

目录项的相对路径必须非空、不得包含 `..`、不得是绝对路径。恢复器在碰磁盘前再次校验整个
manifest，拒绝重复路径、逃逸路径、类型冲突和缺失 blob。首版保证内容字节与树形结构；mtime、
ACL、扩展属性和平台专有元数据不属于完成判据。

### 3. 大文件全程流式

BlobStore 增加流式写入口。文件实现边读边写临时文件并计算 sha256，随后
`fsync → rename → fsync directory`；返回 `BlobRef` 时仍满足“内容已持久化”。Checkpoint
不得因为文件超过固定阈值而降级，也不得把大文件一次性物化到主进程内存。

manifest 本身有条目数、路径长度和编码后的总字节上限；达到上限时快照失败关闭，而不是生成
一个不完整清单。内容 blob 不受 8 MiB 旧上限限制。

### 4. 恢复是一次性、可重试、可审计的状态迁移

提供 checkpoint 列表、详情和恢复入口。尚未恢复的 checkpoint 状态为 `ready`；成功写入
`checkpoint.restored` 后为 `restored`，同一 checkpoint 不得再次恢复。

恢复开始和失败分别写入 `checkpoint.restore.started` 与 `checkpoint.restore.failed`；成功才写
`checkpoint.restored`。恢复前先校验 manifest 和全部 blob，再把文件内容写到同目录临时文件。
多目标按确定顺序应用，失败后保留 checkpoint 为可重试状态；恢复操作设计为幂等，重试会继续把
整组目标收敛到 manifest 描述的状态。事件流因此能区分“从未尝试”“进行中崩溃”“失败可重试”
和“已成功恢复”。

重启后状态完全由持久事件回放得到。若最后一条状态是 `restore.started`，UI 显示“恢复中断，
可重试”，不猜测磁盘是否已经全部完成。

### 5. GC 只能做可证明的图遍历

GC 的根集合是所有持久事件和有效状态快照里的 `BlobRef`。Checkpoint manifest 是一种可递归
解析的节点：`manifestRef` 可达时，其中每个文件内容引用也可达。只有完成“收集根 → 解析全部
manifest → 标记闭包 → 二次核对事件库”的实现和契约测试后，BlobStore 才能增加删除能力。

M2-c 的恢复闭环不以 GC 为前提；证明不足时继续只增不删。

## 后果

- 正面：文件、目录、新建、删除、大文件和多个声明目标共享同一个可恢复、可回放的逻辑还原点。
- 正面：`shell.exec` / `shell.session.run` 不需要 checkpoint 特例，只要命令分析给出了具体目标。
- 正面：事件只引用一份小 manifest，目录大小不会直接放大 SQLite 事件行。
- 代价：恢复前必须读完整 manifest 并校验所有内容引用，开始写盘的延迟高于直接覆盖。
- 代价：跨多个路径不可能获得通用文件系统原子提交；首版依靠写前完整校验、同目录原子替换、
  确定顺序和幂等重试收敛，不宣称崩溃瞬间零中间态。
- 重新评估条件：若需要恢复未声明的任意进程副作用，必须引入 OS 级快照/沙箱或文件系统监听，
  不能放宽为扫描整个工作区并猜测变化。
