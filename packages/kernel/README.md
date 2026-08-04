# `@xm/kernel`

小明的**纯逻辑内核**。

## 这个包负责什么

| 模块 | 职责 |
|---|---|
| `state/reduce.ts` | 事件流 → 会话状态。纯函数，带穷尽性检查 |
| `state/seq.ts` | `seq` 不变量校验（单调、无空洞） |
| `policy/engine.ts` | 权限判定。纯函数，可穷举测试 |
| `policy/defaults.ts` | 红线（immutable）与平衡档默认规则 |
| `policy/target.ts` | 路径目标的词法规范化。安全边界的前置条件，见下方约束三 |
| `tool/registry.ts` | 工具注册、schema 子集校验、入参类型擦除 |
| `tool/truncate.ts` | 结果截断与对模型可见的截断标记 |

## 不负责什么

- **任何 I/O**。零 `node:*`、零 `electron`、零网络、零文件系统（dependency-cruiser 在 CI 强制）。
  单元测试必须能在无网络、无文件系统的环境下全绿——这是原则二的具体形态。
- 数据形状定义。那是 `@xm/contracts`。
- 装配。把 Provider / 工具 / 存储拼成可运行的引擎是 `@xm/runtime` 的事。

之所以要这么克制：内核要能在浏览器、Node、测试里以**完全相同**的方式运行。
这既是"CLI 与桌面共用同一个引擎"的前提，也是 ADR-0001 里"未来可换外壳"那条退路的实际载体。

## 三条容易被破坏的约束

**一、`reduce` 里瞬态事件必须是空操作。**
`message.delta` / `tool.progress` 不得改变状态的任何一位，包括 `lastSeq`。
这不是"还没实现"，是 ADR-0008 的硬不变量——`tests/persistence-containment.test.ts` 把它变成 CI 闸门。
一旦有人图省事把关键状态只放进 delta，历史会话就再也 reduce 不出正确结果。

**二、`reduce` 不得依赖事件之外的任何输入。**
不读时间、不取随机数、不碰文件系统。需要 ID 时用事件自身的 `id` 派生（见 `turn.start` 分支）。
违反这条，回放就不再是回放。

**三、红线规则改不得，且必须按"运行时真会传的字符串"测。**
`policy/defaults.ts` 里 `immutable: true` 的规则任何档位都不可覆盖，YOLO 也一样。
`red.self-modify-*` 一组禁止小明修改策略目录、权限契约、密钥契约、脱敏出口、`scripts/`、
depcruise/eslint 配置、githooks 与 CI workflow——红线能被自己改掉，就等于没有红线。

⚠️ **红线是参数化的**：`builtinRules({ home, appRoot })`，两个参数必填。
内核零 I/O 拿不到 `homedir()`，就不该假装知道。这不是形式主义——上一版把家目录写成字面量 `~`，
而运行时传的永远是展开后的 `/home/ming`，那条红线**从写下的那一刻起就没有生效过**（ADR-0012 ①）。

配套的是 `policy/target.ts`：路径类能力先规范化再匹配，**规范化失败直接 deny**
（判不了就拒绝——ask 的下一步是用户点"允许"）。符号链接解析归运行时的能力网关，那一层才有文件系统。

写这类测试时按"攻击者会怎么拼这个字符串"来写，不要拿规则自己的字面量去测规则——
那测的是 `globMatch` 会不会用，不是红线会不会拦。见 `tests/policy-redlines.test.ts`。

## 相关文档

- [docs/04 总体架构](../../docs/04-总体架构.md)
- [docs/10 契约设计](../../docs/10-契约设计.md)
- [ADR-0003 默认权限策略](../../docs/adr/0003-默认权限策略.md)
- [ADR-0005 工具并发与资源声明](../../docs/adr/0005-工具并发与资源声明.md)
- [ADR-0008 事件持久化分层与演进](../../docs/adr/0008-事件持久化分层与演进.md)
