# ADR-0022 · Provider 传输层、密钥归宿，以及中断时那条被漏掉的不变量

- **状态**：🟢 Accepted（2026-08-06）
- **日期**：2026-08-06
- **相关**：落地 M1-b；实现 [ADR-0007](./0007-平台支持分级.md) 保险 2 的密钥三态；闭合 [ADR-0021](./0021-流式渲染与第二份状态的边界.md) 遗留的「没人发 `message.interrupted`」；细化 [ADR-0016](./0016-原生模块与打包.md)（不新增原生模块）

## 背景

M1-a 之后，`ModelProvider` 端口、`ModelChunk` 中立形状、`SecretBackend` 三态、
`message.interrupted` / `usage.recorded` / `notice.posted` 事件**全都已经在了**——
但一个 Provider 实现都没有，`SecretStore` 只是个名字，配置文件从来没被读过一次，
`costUsd` 恒为 0。

这一轮把纸面变成代码，过程中撞出四个够得上 ADR 的决定。

## 决策

### 一、传输层手写 `fetch + SSE`，不引 SDK

`@xm/providers` 新包，依赖只有 `@xm/contracts` + `@xm/kernel`，**不 import 任何 `node:*`**。

三条理由，按重要性排：

1. **取消语义必须是我们自己的。** 「点停止 200ms 内真停」这条 DoD 的落点是
   `AbortLike → AbortSignal` 那十几行桥接。套 SDK 等于把它交给别人的 abort 实现，
   而各家 SDK 的取消行为并不一致。
2. **一个 SSE 读取器喂两家。** 用官方 SDK 要引两个（Anthropic 一个、OpenAI 一个），
   两边的取消与错误语义各不相同，还得在上面再糊一层归一——比手写多一层。
3. **供应链表面。** contracts / kernel 都坚持零依赖，这里是全项目最大的一笔新增表面。

代价明写：wire format 漂移、错误分类、429 退避都归我们维护。缓解办法是
**未知一律忽略**——未知 SSE 事件、未知 delta 类型、未知字段全部跳过并继续，
与 `EventEnvelope` 用 loose 是同一条理由：上游加字段是版本漂移的正常形态，不是错误。

顺带一个不显眼但有用的性质：**这个包读不到 `process.env`**（depcruise 规则
`providers-零-node内置` 钉着）。于是密钥的唯一来源只能是调用方传进来的 `apiKey`，
而那个值只能出自 `SecretStore`——一条「顺手 `process.env.ANTHROPIC_API_KEY`」的
捷径在这里编译不过。

### 二、OpenAI 兼容与 Anthropic 同段落地

端口注释写着「各家的差异全部在适配器里消化，不上浮」。**只有一个实现时这句话无法证伪**：
任何绑死一家的假设都会舒服地待在端口里，直到接第二家才暴露，而那时上面已经压着
ContextBuilder、压缩与缓存断点。

接第二家当场抓到三处差异，三处都留在了适配器里：

| 差异 | 消化方式 |
|---|---|
| 块模型 → 扁平 content | `toWireMessages()` |
| 工具结果要从 user 消息里**拆成独立消息** | 同上，一条中立消息可能变成三条 |
| 思考块无法回传 | 丢弃（并写清为什么丢它不同于丢图片） |

中立性有一条可执行的用例：**同一个 `ModelRequest` 喂两家，断言解出的 chunk 序列一致**。
合法差异只剩两处（`thinking_signature`、`cacheWriteTokens`），且每一处都说得出
「这是各家真实的能力差异」。清单一长，就说明差异开始往上浮了。

### 三、密钥：只有钥匙串，或者明确地存不了

`SecretStore` 端口在内核（只有类型），三个实现按 `withCapabilities` 的老路往上抬：

| 后端 | 实现 | 位置 |
|---|---|---|
| `keychain` | Electron `safeStorage`（macOS Keychain / Windows DPAPI / libsecret） | `apps/desktop/src/main/secrets.ts` |
| `encrypted-file` | scrypt + AES-256-GCM，`node:crypto` | `packages/platform/src/secret-file.ts` |
| `plaintext-unavailable` | `set()` **抛** | `packages/platform/src/secret-unavailable.ts` |

走 `safeStorage` 而不是原生模块（`keytar` 已归档）：同一组 OS 后端，**零新增原生依赖**，
不动 ADR-0016 刚合上的那笔账。

三条写进接口形状里的规定：`list()` 只返回条目名永不返回值；`backend` 是探测出的只读事实；
**`set()` 在存不了时抛而不是返回 false**——返回值可以被忽略，而"存密钥失败了但程序继续跑"
意味着用户以为自己存上了。

> 参考项目那个含真实 API key 且已提交进 git 的 `config.yaml`，不是某个人某天疏忽写出来的，
> 而是**"当时没有别的地方可以放"的必然结果**。只要存在一条"先明文存着，回头再说"的路径，
> 它就会被走。所以这里不提供那条路径。

M1-b 的桌面装配里**只接了钥匙串与不可用两档**：加密文件那档需要一个"设置主口令"的界面，
而那是配置中心（M3）。代码与用例都已就绪，接上只是一个界面的事。

### 四、中断是**两条**事件，不是一条

这是本轮唯一一个"想当然会写错"的地方，也是探查阶段才发现的。

直觉写法是「中断时只发 `message.interrupted`」。但 `message.delta` 已经把文字推给了
订阅者——屏幕上打出来了——而持久流里没有任何事件包含它。**ADR-0008 的包含性不变量
当场破掉**，表现是用户看着打字机打出半句话，重开会话后那半句凭空消失。

反过来「只发 `message.end`」也不行：那条被截断的回复看起来和一条正常回复完全一样，
用户回看历史时无从分辨。

所以顺序是：

```
message.end          已到达的部分进 messages，模型下一轮看得见自己说到哪
message.interrupted  UI 据此标注，live buffer 据此归零（ADR-0021）
```

同一段 `catch` 还接住了 Provider 抛错：**错误不跨越 Turn 循环**，照常落
`message.end` + 一条 `error.raised(fatal: false)`。理由完全相同。

### 五、价格表是配置，且**仓库里不带默认值**

`usage.ts` 早就写死「成本不在 Provider 里算」。这一轮补上 `costOf()` 之后出现一个新问题：
表是空的时候成本该显示什么。

**`costOf()` 算不出来返回 `undefined`，不返回 0。** 返回 0 会让"这次没花钱"和
"我们不知道花了多少"变成同一个值，而 UI 只能显示前者——用户看到一个精确到分的 $0.00。
`usage.recorded` 因此多一个可选的 `priced` 字段，`SessionState.usage` 多一个 `unpricedTurns`，
UI 显示成「≥ $0.42（3 次未计价）」。

不带默认价格表，是因为**带一份就等于发布一个会过期的事实**：价格改了而仓库没跟上时，
UI 照样显示一个精确的数字，用户没有任何线索知道它是错的。

## 后果

**正面**

- 能和真模型对话了；两家实现互为对方的中立性证据
- 密钥有了唯一的归宿，且"明文"不在选项里
- 配置文件第一次被真的读过（schema 与合并语义从 M0 起就在，此前从未被文件喂到）
- 测试 372 → 446

**顺带修出的真 bug**：`fileSecretStore` 的 scrypt 参数 `N=32768` 需要 33.5 MB 内存，
而 Node 的默认 `maxmem` 恰好是 32 MB——差这 1.5 MB，`set()` 在真实环境里直接抛
`memory limit exceeded`。参数看着更安全，实际是一条**存不进密钥的路径**。
第一条用例就把它照出来了。

**反向演练**（14 条全部当场转红，逐一还原）

| 演练 | 结果 |
|---|---|
| 取消不转发给 fetch（退化成轮询语义） | 2 红，其中一条**挂满 5 秒超时**——正是它要防的形态 |
| 中断时不落 `message.end` | 2 红，含包含性不变量那条 |
| 中断时不发 `message.interrupted` | 2 红 |
| 存不了时 `set()` 静默成功 | 1 红 |
| 配置里的明文密钥不检查 | 1 红 |
| 错误正文不过 `redact` | 1 红 |
| 429 与 4xx 一视同仁地重试 | 1 红 |
| usage 发两条 | 3 红 |
| OpenAI 不减掉缓存命中的 token | 2 红 |
| 成本算不出时返回 0 | 2 红 |
| 直接用服务端的 `toolu_…` 当 CallId | 1 红 |
| SSE 提前退出不 cancel 底层流 | 1 红 |
| 多模态悄悄降级成一句文字 | 1 红 |
| SSE 碰到未知行就抛 | 1 红 |

**负面 / 遗留**

- **真实 wire format 只靠手写 fixture 覆盖。** 用例回放的是
  `packages/providers/tests/fixtures/*.sse`，形状照文档写，**没有真调过 API**。
  这正是本项目栽过两次的形状（ADR-0017 / ADR-0018：测试全绿、真实输入下从未跑过）。
  缓解是"未知一律忽略"，但**第一次真调用仍然是一次真正的验收**，要按验收对待。
- **加密文件后端没有入口。** 实现与用例都在，缺一个"设置主口令"的界面（M3 配置中心）。
- **多模态失败关闭。** 图片/文档块直接抛 `unsupported`，M1-d 接上。
  刻意不降级成 `[图片]`——看不见的降级会让模型自信地描述一张没见过的图。
- **`buildRequest()` 仍然是 M0-b 那个朴素形态**：system 为空、messages 全量、
  没有缓存断点。ContextBuilder 与压缩是 M2（ADR-0006）。
- **审批 UI 还没有**，`ask` 一律拒绝（M1-c）。

## 这次值得记住的

> **一个端口的"中立性"，在只有一个实现的时候是无法证伪的。**

`ModelProvider` 端口从 M0-a 起就写着「各家差异全部在适配器里消化，不上浮」，
六份 ADR 引用过它，没有一个人怀疑过。而接第二家的第一小时就抓到三处差异——
它们本来会一直待在端口里，直到 M3 才暴露，那时改动面大一个数量级。

这与「规则存在 ≠ 规则生效」是同一件事的另一个面：**约定存在 ≠ 约定被检验**。
一条只有一个实现的接口，等于一条没有被检验过的约定。
