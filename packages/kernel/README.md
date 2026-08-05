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
| `port/event-store.ts` | 事件存储端口：接口 + 七条不变量 + `SealedEvent`（ADR-0013） |
| `port/summary-projection.ts` | 会话摘要投影的唯一推进规则 |
| `port/memory-event-store.ts` | 端口的参考实现，供冒烟/回放/单测使用 |
| `port/event-store-contract.ts` | 端口一致性用例（12 条），任何实现都要全过 |
| `port/blob-store.ts` | Blob 端口 + `collectBlobRefs()`（坏引用检测的基础） |
| `port/memory-blob-store.ts` `port/blob-store-contract.ts` | 同上的参考实现与一致性用例 |
| `port/platform.ts` | 平台端口 + `XmPaths` + `xmDataLayout()`（ADR-0014） |
| `port/model-provider.ts` | 模型提供商端口（docs/04 §4.1 的实现级版本） |

## 不负责什么

- **任何 I/O**。零 `node:*`、零 `electron`、零网络、零文件系统（dependency-cruiser 在 CI 强制）。
  单元测试必须能在无网络、无文件系统的环境下全绿——这是原则二的具体形态。
- 数据形状定义。那是 `@xm/contracts`。
- 装配。把 Provider / 工具 / 存储拼成可运行的引擎是 `@xm/runtime` 的事。

之所以要这么克制：内核要能在浏览器、Node、测试里以**完全相同**的方式运行。
这既是"CLI 与桌面共用同一个引擎"的前提，也是 ADR-0001 里"未来可换外壳"那条退路的实际载体。

## 四条容易被破坏的约束

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

⚠️ **红线是参数化的**：`builtinRules({ home, appRoot, dataDir })`，三个参数全部必填。
内核零 I/O 拿不到 `homedir()`，就不该假装知道。这不是形式主义——上一版把家目录写成字面量 `~`，
而运行时传的永远是展开后的 `/home/ming`，那条红线**从写下的那一刻起就没有生效过**（ADR-0012 ①）。

`dataDir` 是 M0-b 补的，补的原因是同一件事又发生了一次：docs/06 §7 写了整整一个里程碑的
"禁止写入审计库路径"，而代码里**一条对应规则都没有**——`PolicyEnv` 拿不到数据目录，写不出来
（ADR-0014）。别手写这三个值，走唯一的通路：

```ts
const rules = builtinRules(policyEnvFromPaths(platform.paths()));
```

配套的是 `policy/target.ts`：路径类能力先规范化再匹配，**规范化失败直接 deny**
（判不了就拒绝——ask 的下一步是用户点"允许"）。符号链接解析归运行时的能力网关，那一层才有文件系统。

写这类测试时按"攻击者会怎么拼这个字符串"来写，不要拿规则自己的字面量去测规则——
那测的是 `globMatch` 会不会用，不是红线会不会拦。见 `tests/policy-redlines.test.ts`。

**四、进存储的事件必须过 `sealEvent()`，端口契约必须留在 `src/`。**
`SessionWriter.append` 只收 `SealedEvent`，而 `sealEvent()` 是它唯一的生产者——
这是 ADR-0012 记下的"`redact()` 有契约、无执行点"的闭合点，绕过它需要显式 `as`。
`sealEvent` 内部脱敏后**重新校验 schema**：这不是冗余，它当场抓到过 `redact()`
把 `usage.recorded` 的 `inputTokens` 换成 `'***'`（键名正则里的 `token` 不带边界）。

`event-store-contract.ts` 放在 `src/` 而不是 `tests/`，是为了让 `packages/storage`
的测试能 import 它——跨包 import 一个 `.test.ts` 走不通。它因此不能依赖 vitest：
每条用例就是一个抛异常表示失败的 async 函数。

## 相关文档

- [docs/04 总体架构](../../docs/04-总体架构.md)
- [docs/10 契约设计](../../docs/10-契约设计.md)
- [ADR-0003 默认权限策略](../../docs/adr/0003-默认权限策略.md)
- [ADR-0005 工具并发与资源声明](../../docs/adr/0005-工具并发与资源声明.md)
- [ADR-0008 事件持久化分层与演进](../../docs/adr/0008-事件持久化分层与演进.md)
