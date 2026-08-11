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

## 补记（2026-08-07）：DeepSeek 400，以及"工具名带点号"这个从没被验证过的假设

用户在 Windows 本地跑真实 DeepSeek（OpenAI 兼容端点）时，带工具的请求一律
400：

```
Invalid 'tools[0].function.name': string does not match pattern.
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
```

`fs.read` / `fs.list` / `fs.write` / `shell.exec` 这些工具名**就是能力字符串本身**
（判权用的是同一个字符串），而 `ToolDescriptor.name` 的契约反过来强制要求至少
一个点号（`descriptor.ts`：`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/`）。两条约束
互相矛盾，而 `openai-compatible.ts` 把 `t.name` 原样塞进 `tools[].function.name`，
一次也没清洗过。

**这不是 DeepSeek 独有的**：`anthropic.ts` 的 `toWire()` 同样把 `t.name` 原样塞进
`tools[].name`，Anthropic 的文档写的是同一条正则。两个适配器共享同一个从没被
验证过的假设——只是 DeepSeek 的错误信息把它说得比较明白。

### 为什么这个坑活了一整个 M1-c + M1-d 都没被抓到

CI 里两类测试都天然绕开了它：

- `recorded.test.ts` 用预录的 SSE fixture 测"我们能不能正确解析一个假想的响应"，
  从不会触发真实服务端对**出站请求**的校验；
- 唯一会打真实网络的 `live.test.ts` 挂在 `XM_LIVE_PROVIDER=1` 后面（docs/08 的
  明确决定：CI 一次不花钱调用），而它自己的 `WEATHER_TOOL.name = 'weather.get'`
  ——**同样带点**——是 M1-b 写下的，那时手动跑过一轮（本文件上面那次补记）。
  M1-c 才装上真正带点号的能力工具，而没有人在那之后重新手动跑过带工具调用的
  `XM_LIVE_PROVIDER=1`。

这是 ADR-0025/0026 反复出现的那句话的第三个变体：**约定存在 ≠ 约定被检验，
而检验本身也可能在被检验的东西变了之后过期**——`live.test.ts` 曾经检验过
"能不能带工具调用"，但检验用的工具名恰好没有触发这个坑，装上真实工具之后
这份检验就悄悄失效了，而没有任何信号提示它失效了。

### 修复：两个适配器共享一份 wire 名编解码，不是各自清洗一遍

新增 `packages/providers/src/tool-name.ts` 的 `buildToolNameCodec()`：按**这次
请求**的 `tools` 列表现算一份双向表（点号换下划线；清洗后撞车则追加数字后缀，
因为插件工具名不受能力表这个闭集约束，不能假设清洗后互不相同）。`stream()`
里只算一次，`toWire()` 编码、`decodeStream()` 解码用的是同一份表——写在两个
适配器各自的文件里、却共享同一个从 `tool-name.ts` 导入的函数，不是"两边各写
一遍清洗逻辑"。三处都要编码：`tools[]` 声明、`tool_choice`、历史消息里的
`tool_use` 块（服务端会拿它跟 `tools[]` 里的名字核对，只编码声明那一处，
历史消息里的名字对不上）。

### 顺带补的第二个缺口：`lastError` 从来没有渲染代码读过它

同一份 bug 报告里的次要问题：Provider 返回 400 时，"发消息"这个 IPC 调用本身
成功返回（失败发生在 Turn 内部的流式读取里），渲染层顶部那条 `error`（`store.ts`
里只捕获 IPC 调用失败）永远不会被置上。而 `reduce()` 从一开始就在 `error.raised`
时正确写入了 `SessionState.lastError`——**只是没有任何渲染代码读过它**，用户
看到的只是"发了消息但没反应"。

补的时候顺带发现 `lastError` 只写不清：一次失败之后，哪怕后面一百轮都成功，
这条错误理论上会一直挂在界面上。改成 `turn.start` 时清掉——新一轮的用户输入
本身就是"要重试"的信号，不需要一个专门的关闭按钮。

**账**：780 测试（+12：`tool-name.test.ts` 10 条 + `reduce.test.ts` 2 条）；
`pnpm verify` 全绿。这一轮没有真实 API 可用，两个适配器的编解码用手写的
wire 形状验证（照抄真实 fixture 的结构，换一个会撞正则的工具名），
不是等价于 `XM_LIVE_PROVIDER=1` 的验证强度——**这笔账还欠着**，下一次有真实
key 可用时应该跑一轮带工具调用的 live 用例，把上面提到的"检验本身过期了"
这件事真正补上，而不是只在 mock 层面自洽。

## 补记（2026-08-07 · 续）：欠的那笔账被用户自己的真实调用还上了——顺带带出下一个 400

上面那笔"没有真实 key，验证不到 `XM_LIVE_PROVIDER=1` 强度"的账，没等太久：
用户拿同一版代码在 Windows 本地接真实 DeepSeek 跑了一轮。结果是好消息也是
坏消息——**工具名带点号那个 400 确实不再出现了**（编解码那份修复站住了），
但带工具调用的下一轮请求换了一个新的 400：

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

DeepSeek 思考模式的文档（Tool Calls 一节）写明：一旦某一轮 assistant 消息带过
`tool_calls`，下一轮请求必须把那一轮的 `reasoning_content` 原样带回去，不带
就拒绝。而 `openai-compatible.ts` 的 `toWireMessages` 里，`thinking` 块从
第一天起就是**直接丢弃**——注释原文是"这一家的 wire format 收不回自己的推理
内容（`reasoning_content` 是只出不进的），硬塞会被 400 拒"。这句话读起来像是
查过文档，实际上是凭直觉写的（大多数 OpenAI 兼容端点确实把 `reasoning_content`
当只出字段，但 DeepSeek 思考模式是个例外，而且是**文档写明的强制例外**），
从来没有被真实请求验证过——直到这次。

这与本文件最初那次补记是同一个形状：`recorded.test.ts` 的 fixture 只验证
"收到一份带 `reasoning_content` 的响应能不能解析成 `thinking_delta`"，从不
验证"历史消息里的 `thinking` 块会不会被正确编码回 `reasoning_content` 发出
去"——**同一个字段，一进一出，测试只覆盖了出，没覆盖进**，而代码注释里
"回不去"这句断言恰恰错在"进"这一半。

修法：`toWireMessages` 里 `thinking` 块不再丢弃，累积文本挂到对应 assistant
消息的 `reasoning_content` 字段（只在真出现过思考文本时才带这个字段，不
无端多塞一个字段给不认它的兼容端）。`redacted_thinking`（Anthropic 私有的
加密块）继续丢弃——这一家的 wire format 里没有对应位置可放，和"要不要回传"
无关，是"有没有地方接"的问题。Anthropic 适配器不受影响：`signature` 字段
本来就在正常回传，这个坑是 OpenAI 兼容这一侧独有的。

### 顺带修的另一半：一次调用多条 ask 主张时「点了没反应」

同一份报告里的第二个 bug，和本文件内容无关，是 [ADR-0026](./0026-命令的主张分解与argv契约.md)
「一次调用可以产生多条 `PermissionClaim`」这件事在**问用户**这一步留下的
后半个洞——`turn.ts` 会把多条 ask 主张的 `permission.request` 事件连着发完，
才轮到第一条的 `permission.decision`，而 `pendingPermission` 是单槽位，
会被最后一条覆盖，UI 卡片的 `requestId` 因此和运行时正在等待的那一条对不上，
点确认按钮没有反应。详细机制与修法记在 ADR-0026 的补记里，这里只做交叉引用，
避免同一件事在两份 ADR 里各写一半、日后改动只改了一边。

**账**：新增/改动测试见 `adapters.test.ts`（reasoning_content 编码的正反两条
用例）与 `shell-claims.test.ts`（多主张 ask 的事件交替用例，见 ADR-0026 补记）；
`pnpm verify` 全绿，783 测试。这一轮同样没有真实 key 可用，`reasoning_content`
的编码用手写的历史消息结构验证，**没有验证到"模型侧真的接受了回传的
reasoning_content、后续多轮工具调用不再报错"这一层**——这笔账比上一笔更具体：
下次有真实 key，应该专门跑一轮"assistant(thinking + tool_use) → tool_result →
再来一轮工具调用"的多轮 live 用例，而不是单轮。

---

## 补记（2026-08-10）：上一笔账还上了，而它照出的是同一个修复只修了一半

上面结尾欠着一句："下次有真实 key，应该专门跑一轮『assistant(thinking + tool_use)
→ tool_result → 再来一轮工具调用』的多轮 live 用例，而不是单轮。"

这笔账是被用户的真实体验先一步撞开的。同一条报错原文重新出现：

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

**但它不是 8/7 那次修复的回归。** 同一个会话里，第一轮多轮工具调用全程成功——
说明"有非空 thinking 就回传"这条路是通的。出事的是紧挨着它的另一半：模型某一轮
**没吐思考文本、只吐了 `tool_calls`**。于是 `thinking !== ''` 的落库闸门不写块、
`reasoningText !== ''` 的出站闸门不写字段，wire 上 `tool_calls` 在、
`reasoning_content` 不在 —— 400。

### 这一次先问服务端，再改代码

上一次的教训是"注释里那句断言是凭直觉写的，从没被真实请求验证过"。所以这次的
顺序反过来：先拿真实 key 打一组探针，把契约问死，再动代码。结果有三档，
其中一档是**光看文档一定会踩的**：

| 发出去的形状 | 服务端 |
|---|---|
| 完全不带 `reasoning_content` | **400** |
| `reasoning_content: null` | **400** |
| `reasoning_content: ""` | 200 |
| `reasoning_content: "非空文本"` | 200 |

`null` 也被拒这一条很关键：DeepSeek 官方示例写的是把 `message.reasoning_content`
原样回传，而无思考的那一轮它就是 `None`/`null`——照抄示例正好落进 400 那一档。
**空的表示只有空串这一种是对的。**

### 修法：把闸门从"有没有思考文本"换成"这条链路认不认这个字段"

`toWireMessages` 的条件从 `reasoningText !== ''` 改成
`reasoningText !== '' || (reasoningRequired && toolCalls.length > 0)`。

`reasoningRequired` 由 `toWire` 一次算好，两个来源缺一不可：

1. **能力表说这个模型会思考**（`catalog.ts` 的 `thinking`）。这是开局就生效的一半——
   哪怕第一条 assistant 就是"没有思考文本的 tool call"，字段也不会缺。
   顺带修掉一个反讽：表里此前**根本没有 deepseek 条目**，
   `capabilitiesFor('deepseek-v4-flash').thinking` 取兜底值 `false`——
   我们一边给它回传思考内容，一边在能力表里声明它不会思考。
2. **这段历史里实际出现过 thinking 块**。这是兜底的一半：能力表永远追不上新模型，
   而"这一家真的吐过 reasoning"是比任何表都硬的证据。出事的那个会话正是这个形状。

为什么要这道闸门、而不是"有 `tool_calls` 就无条件带"：无条件带会让 OpenAI 官方、
Azure、各类网关在**每一轮工具调用**上都收到一个 `reasoning_content: ""`。上一版
注释"不认它的兼容端不该无端多收一个陌生字段"这句话本身是对的，错的是它把
"有没有思考文本"当成了"认不认这个字段"——两者在无思考轮上分叉。修的是判据，
不是意图。

**没做的两件事**，记下来免得日后被当成遗漏：

- 不在 `turn.ts` 为"有 tool_use 的空思考"落一个占位 `thinking: { text: '' }` 块。
  那会把空块扩散进 UI 与投影，为了一个纯粹的传输层问题污染领域模型。
- 不做"打开旧会话时扫描并修补脏历史"。这个修复在**编码时**生效、不落库，
  已经 400 过的旧会话下一次发送就自动好了——那份扫描代码永远不会被触发。

### 账

- `adapters.test.ts` 新增一组三条（思考模型无 thinking 也带字段 / 不思考的兼容端
  一个字段都不多发 / 能力表不认但历史里真吐过思考的模型同样补上）。前两条里的
  两条正向用例在改代码前确认是红的。
- `live.test.ts` 补上欠的那条多轮用例：历史里放一条"只有 tool_calls、没有思考"的
  assistant，真发一次。**带对照组**——把字段拿掉的同一份历史必须真被 400 拒，
  否则这条用例会在服务端哪天放宽规则后变成一条永远绿的空断言。已用真实 key 跑通。

## 补记（2026-08-11）：同一个教训的第三次——空的表示要挑对，而且不止一处

上一次补记的结论是"空的表示只有空串这一种是对的"，说的是 `reasoning_content`。
这次真机撞上的是**紧挨着的另一个字段**，报错原文换了一句：

```
Invalid assistant message: content or tool_calls must be set
```

会话证据（`8305ce03-…`）：

| seq | 事实 |
|---:|---|
| 151 | assistant **只有** thinking 块（约 16k），无 text、无 tool_use |
| 152 | `turn.end reason=max_tokens` |
| 153 | 用户："所以结果是什么" |
| 155–156 | 空 `message.end` + 400 |

模型**思考到把 `max_tokens` 用光，一句正文都没说完**。落库的 assistant 消息于是
只有一个 thinking 块。`toWireMessages` 的 `reasoningText !== ''` 分支放它进 wire，
写成 `{ role: 'assistant', content: null, reasoning_content: "…" }`——没有
`tool_calls`，`content` 是 `null`，服务端要的两个**一个都没给**。

脏历史留在会话里，之后每发一条都会重新拼出同样的请求，会话彻底作废。
用户看到的是"上一轮出错了"，且怎么重发都一样。

### 修法

`content` 的空表示按有没有 `tool_calls` 分档：

```ts
const emptyContent = toolCalls.length > 0 ? null : '';
```

`null` 退回它唯一有据可查的位置——有 `tool_calls` 的那一档，`live.test.ts` 的对照组
用真实服务端证过它收。没有 `tool_calls` 时一律空串。

**不改 `turn.ts`**：thinking-only 消息落库是对的，思考确实发生过；根因在出站编码。
也不做"打开旧会话时扫描修补脏历史"——修复在编码时生效、不落库，已经 400 过的会话
下一次发送就自动好了，那份扫描代码永远不会被触发（与上次补记同一条理由）。

### 顺带接上：`thinking.enabled === false` 的出站翻译

ADR-0038 的会话自动命名在 DeepSeek 上从未成功过，第二个原因就在这一层：
**会思考的模型默认开着思考**，推理文本吃 `max_tokens`，一次只要 24 个字的调用
于是拿回一个空正文。中立层原本表达不出"这次别想"——`ModelRequest.thinking` 只接了
Anthropic 一侧，OpenAI 兼容适配器完全无视它。

现在 `toWire` 把 `thinking.enabled === false` 翻成 `thinking: { type: 'disabled' }`，
两道闸门都必要：

1. **`enabled === false` 才发。** 省略 `thinking` 的调用方（回合主循环）行为一字不变，
   服务端默认原样保留。"省略"和"显式关掉"是两件事，这正是 ADR-0038 栽的那一跤。
2. **`reasoningRequired` 才发**（与 `reasoning_content` 同一道闸门）。OpenAI 官方、
   Azure、各类网关不认这个参数，多发一个陌生字段的下场是整条请求 400——而它们本来
   也不会思考，关了没有意义。两个字段的前提是同一件事：**这条链路说不说思考这门语言。**

`enabled === true` 这一侧**刻意不接**：开思考要配预算、要抬 temperature、要接签名
回传，那是一整条链路，不该顺手在这里开半条。

### 账

`adapters.test.ts` 新增两组六条：空正文的 assistant（thinking-only → `''`；
有 `tool_calls` → 仍是 `null`，不回归），以及关思考的四条正反（思考模型发得出去 /
不思考的兼容端一个字段都不多收 / 不提 thinking 的调用方行为不变 /
`enabled: true` 不接）。两条 🔴 在改代码前确认是红的。

**欠一笔账**：`thinking: { type: 'disabled' }` 这个形状取自 DeepSeek 文档，
**还没拿真实 key 打过探针**——上一次补记的教训是"先问服务端再改代码"，这次没做到。
它落在一条失败即静默的路径上（关不掉最多是标题起不出来，与修复前一样），所以没有
阻塞发布；但下次有真实 key 时应当补一条 `live.test.ts`：发一次 `thinking.disabled`
的请求，断言响应里**没有** `reasoning_content`。带对照组——不带这个参数的同一份请求
必须真的吐思考，否则那条用例证明不了任何事。
