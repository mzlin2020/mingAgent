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
| **（补记）**中断时不清 `failure` | 1 红——正是那条藏了一整段的 bug |
| **（补记）**适配器把 abort 异常原样抛给调用方 | 4 红 |

**负面 / 遗留**

- ~~**真实 wire format 只靠手写 fixture 覆盖。**~~ ✅ 当天补上，见下面的补记。
- **加密文件后端没有入口。** 实现与用例都在，缺一个"设置主口令"的界面（M3 配置中心）。
- **多模态失败关闭。** 图片/文档块直接抛 `unsupported`，M1-d 接上。
  刻意不降级成 `[图片]`——看不见的降级会让模型自信地描述一张没见过的图。
- **`buildRequest()` 仍然是 M0-b 那个朴素形态**：system 为空、messages 全量、
  没有缓存断点。ContextBuilder 与压缩是 M2（ADR-0006）。
- **审批 UI 还没有**，`ask` 一律拒绝（M1-c）。

## 补记（2026-08-06 当天）：第一次真调用，以及它照出来的东西

拿到一把真 key 之后，把上面那笔"没真调过 API"的债当场还了。分两步：

1. **录制**。用 curl 从真实服务端（DeepSeek 的 Anthropic 兼容端点与 OpenAI 兼容端点）
   原样抓下四段 SSE，存进 `tests/fixtures/live-*.sse`，由 `recorded.test.ts` 回放——
   **CI 不需要 key 也能跑**。
2. **真调**。`live.test.ts` 打真实 API，默认整组跳过，只有 `XM_LIVE_PROVIDER=1` 才跑。
   密钥只从环境变量进来，不许有默认值、不许落任何文件。

### 六、取消时**正常结束迭代，不抛**（新增的端口约定）

真调用的第一轮，九条用例里七条直接绿，两条炸——都是「点停止 200ms 内真停」那条。

炸的方式本身就是答案：真实 `fetch` 在 abort 时让正文读取抛 `AbortError`，
一路穿出 `for await`。而 `ModelProvider` 端口**从没规定过取消时迭代器该怎么结束**。

于是每个调用方都得自己分辨"这是用户取消还是真出错"，而第一个调用方就分辨错了：

```
turn.ts:  catch → failure = provider_error("This operation was aborted")
          if (signal.aborted) stopReason = 'aborted'     ← 只纠正了这个
          ...
          if (failure !== undefined && …) → error.raised  ← failure 还在
```

**用户点停止，收到一条红色报错。**

现在端口明写：实现方必须吃掉 abort 抛出的异常，以一条 `{ kind: 'stop', reason: 'aborted' }`
收尾并返回；`turn.ts` 那道 `signal.aborted` 兜底保留（M2 子 Agent、M3 的 MCP 会带进
不受我们控制的实现），但**必须连 `failure` 一起清掉**。

两条跟着定下的细节，都是同一条纪律的推论：

- **中断时不发 `usage`。** 服务端没给最终用量，编一个 `outputTokens: 0` 出来
  就是把"不知道"写成"是零"——与 `costOf()` 算不出返回 `undefined` 完全同源。
- **中断时不补 `tool_call_end`。** 参数 JSON 是一个字符一个字符来的（真实录制里看得很清楚），
  被截断时手里是 `{"ci` 这种半截串。补一条 end 等于告诉上层"这个调用完整了"。

### 录制照出来的其它三处

| 发现 | 手写 fixture 里为什么没有 |
|---|---|
| 没请求 thinking，服务端照样发 thinking 块 | 按文档，不开就不该有。于是「能力表说 thinking: false」与「流里真有 thinking_delta」可以同时成立——`catalog.ts` 的能力值**不能**被当成"流里不会出现什么"的保证 |
| Anthropic 端点返回的 tool id 是 `call_00_…`，不是 `toolu_…` | 照文档写就只会有 `toolu_`。两种都不是 UUID——重映射不是对某家 id 前缀的适配，是对"服务端 id 格式不受我们控制"的适配 |
| 401 正文里服务端回显了 key 尾四位 | 想不到。打码**程度**是对方决定的，所以 `readErrorBody()` 那道 redact 是我们自己的底，不能省 |

顺带一条正面的：OpenAI 侧我们减掉缓存命中 token 的算法（`prompt_tokens - cached_tokens`），
真实响应里服务端**自己也算了一遍**放在 `prompt_cache_miss_tokens`：359 − 256 = 103，逐位相同。
这条断言从"我们认为应该这样减"变成了"服务端确认就是这样减的"。

**补记的账**：458 测试（+12）/ 158 模块 519 边零违规 / contracts 7.13 kB；
9 条 live 用例在真实 API 上全绿，含真实网络下的 200ms 停止。

## 这次值得记住的

> **一个端口的"中立性"，在只有一个实现的时候是无法证伪的。**

`ModelProvider` 端口从 M0-a 起就写着「各家差异全部在适配器里消化，不上浮」，
六份 ADR 引用过它，没有一个人怀疑过。而接第二家的第一小时就抓到三处差异——
它们本来会一直待在端口里，直到 M3 才暴露，那时改动面大一个数量级。

这与「规则存在 ≠ 规则生效」是同一件事的另一个面：**约定存在 ≠ 约定被检验**。
一条只有一个实现的接口，等于一条没有被检验过的约定。

补记又添了第三个面，比前两个更难防：

> **只断言"该发生的发生了"，抓不到"不该发生的也发生了"。**

`interrupt.test.ts` 那一组从第一天起就断言了 `message.end` 与 `message.interrupted`
**存在**、顺序对、包含性不变量成立——四条用例，全绿。它们没有一条问过
"除了这些，还发生了别的吗"。于是一条多余的 `error.raised` 在全绿之下活了整整一段。

而端口那一侧的问题更根本：**约定不存在时，无法证伪的不是实现，是问题本身**。
"取消时该怎么结束"从来没人回答过，所以也没人能说 `turn.ts` 写错了——
直到真实的 `fetch` 替我们回答了它。
