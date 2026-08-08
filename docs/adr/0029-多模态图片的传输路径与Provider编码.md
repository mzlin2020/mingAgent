# ADR-0029 · 多模态图片的传输路径与 Provider 编码

- **状态**：🟢 Accepted（2026-08-08）
- **日期**：2026-08-08
- **相关**：细化 [docs/08](../08-路线图与里程碑.md) M1-d"多模态：图片可以贴进对话"
  一节存档的设计（2026-08-08 设计，本 ADR 落地）；复用 [ADR-0013](./0013-存储引擎选型与EventStore端口.md)
  的 `BlobStore` 端口与内容寻址语义；`runTurn` 能力闸门的"失败关闭、不降级"判断
  标准沿用 [ADR-0028](./0028-web.fetch的IP级SSRF判定与DNS重绑定防护.md)（同一份
  `unsupportedBlob` 哲学：看不见的降级比报错危险）

## 背景

契约层（`ContentBlock.image`/`ResultBlock.image`/`BlobRef`、`TurnStartPayload.input:
ContentBlock[]`）从 M0 起就已经就绪，`BlobStore` 端口与两个实现（`MemoryBlobStore`/
`FileBlobStore`）在 M0-b 就落地了——但没有任何一条真实链路把它们连起来：
`runTurn` 的公开签名是 `userText: string`，两个 Provider 适配器对 `image`/`document`
块一律 `throw`（"多模态是 M1-d 才接上"），桌面 IPC 的 `SendUserMessageRequest` 只有
一个 `text` 字段，渲染层没有任何粘贴/拖拽/文件处理代码。`ModelCapabilities.vision`/
`.documents` 在 `packages/providers/src/catalog.ts` 里已经按模型前缀声明好了值
（`claude-*`/`gpt-*` 都是 `vision: true`），却从来没有任何代码读过它——声明的能力
与实际的代码路径处在两种互相矛盾的状态。

这一轮把"用户在 Composer 里贴图 → 模型看到图"这条链路补完整。

## 决策

### 一、`runTurn` 的输入形状从 `string` 改成 `ContentBlock[]`，新增 `textInput()` 便捷构造

`TurnStartPayload.input` 本来就是 `ContentBlock[]`——`reduce.ts` 早就通用地把它
塞进第一条 `Message.blocks`，真正卡住的只是 `runTurn` 自己的公开签名把它收窄成了
纯文字。改回 `ContentBlock[]` 之后，`turn.start` 的记录逻辑一行都不用改；新增的
`textInput(text)` 是纯文字这个最常见形状的便捷构造，供所有既有调用点（16 处测试 +
4 处 headless 冒烟 + `apps/desktop` 的 1 处真实调用）机械替换。

### 二、vision/documents 能力闸门放在 `runTurn` 入口、记任何事件之前，直接 `throw`

`caps = deps.provider.capabilities(deps.model)`；输入里有 `image` 块但
`!caps.vision`，或有 `document` 块但 `!caps.documents`，直接 `throw`，**不记录
`turn.start`**。

放在事件记录之前是硬约束，不是风格偏好：`turn.start` 一旦落库就必须有一条
`turn.end` 收尾配对（ADR-0008 的包含性不变量）。如果放任图片块流到 Provider 深处
才失败关闭，就会留下一条只有开始没有收尾的事件流——这正是"规则存在 ≠ 规则生效"
在这里的具体形状：`turn.start` 记录代码本身没有错，错在闸门摆错了位置。

直接 `throw` 而不是新增一个 `StopReason` 枚举值：`StopReason` 的六个值全部描述
"模型侧或循环侧怎么结束的"，"入参在结构上就发不出去"是另一类事情，混进同一个
枚举会让 `mapStopReason`（两个 Provider 适配器）与所有消费 `StopReason` 的 switch
都多出一个不属于它们语义范围的分支。异常经既有链路（`services.sendUserMessage`
的 `try/finally` → IPC `handle()` 的 catch → `{ok:false}` 信封 → 渲染层 `IpcError`
→ `store.send()` 的 `catch` → 已有的 `error` 状态）原样落地，不需要新造一条
"被拒绝"的收尾语义。

**只查这一轮新输入，不审计历史消息**：中途把模型换成不支持 vision 的、历史消息里
却带着图片，闸门不会拦——`buildRequest()` 会把全量历史原样带上，报错发生在
Provider 深处。这是已知的范围边界，见「遗留」。

### 三、IPC 传输走 base64 字符串，不引入第二条二进制传输形态

`SendUserMessageRequest` 新增 `images: ImageAttachment[]`（`{data, mime, name?}`，
`data` 是 base64），复用现有的 zod 校验体系与信封模式，而不是给 Electron IPC 开一条
结构化克隆二进制的路。渲染层用 `FileReader.readAsDataURL()` 拿 base64，成本可以
接受（单图上限 10MB，base64 膨胀后 ~14MB，本机 IPC 一次性传输不是问题）。

限额三层落地，且**故意不是同一层**：
- 客户端（`Composer`）先挡一遍——张数、大小超标就地报错，不让用户白等一次网络往返；
- `SendUserMessageRequest` 的 zod schema 挡 base64 字符数（粗筛，膨胀系数不精确）；
- `decodeImageAttachment()`（`apps/desktop/src/main/multimodal-input.ts`）在
  `Buffer.from(data,'base64')` 解码之后再按精确字节数查一次，这才是真正的数字。

三层里只有第三层是真正的强制——第一层是体验优化，第二层是"别让明显超标的东西
进 `JSON.parse`"，防的是不同的事，缺一层不能顶另一层。

### 四、渲染层反查 blob 内容走新 IPC 通道 `xm:read-blob`，不需要额外授权

`stores.blobs`（`BlobStore`）此前只在主进程内部用（checkpoint 快照、超限工具结果
归档），渲染层从没读过 blob 字节。新增的 `readBlob(ref: BlobRef): Promise<{dataUrl}>`
接受一个**完整的 `BlobRef`**（不是裸 hash）——渲染层能构造出这个请求，前提是它已经
从事件流里见过这条 `BlobRef`（图片块本来就带着它），能读到这条事件本身就是这个
会话看得见这个引用的全部证明，不需要再传 `sessionId` 做二次校验。

### 五、写入侧不新增 IPC 通道——图片的落盘发生在 `sendUserMessage` 内部

没有单独的"写 blob"通道：`Services.sendUserMessage` 收到 `images` 之后，在组装
`ContentBlock[]` 的同一次调用里直接 `stores.blobs.put()`。分成两次 IPC（先写 blob
拿 ref，再发消息带 ref）会在两次调用之间开一个"blob 已经落盘、消息还没发出"的
中间态，对这个场景没有任何收益，只多一次往返与一种新的部分失败模式。

组装顺序**图片在前、文字在后**——已知的简化，等 UI 支持交替插入再放开，与
docs/08 存档设计一致。

### 六、Provider 适配器的 base64 编码不能用 `Buffer`

`packages/providers/src` 有一条 depcruise 规则（`providers-零-node内置`）与配套的
`tsconfig.json`（`lib: ['ES2023', 'DOM']`，不含 `types: ['node']`）联手保证这个包
只用 Web 平台 API——密钥只能来自调用方传入的 `apiKey`，不能来自
`process.env.ANTHROPIC_API_KEY`。这条约束对 base64 编码同样生效：新写的
`blobToBase64()`（`packages/providers/src/blob.ts`）用 `btoa` + 分块
`String.fromCharCode`，不是 `Buffer.from(...).toString('base64')`。

分块（`0x8000` 字节一批）是因为 `String.fromCharCode(...bytes)` 直接展开一个几 MB
的 `Uint8Array` 会撞 JS 引擎对函数参数个数的上限——这不是理论风险，10MB 的图片
展开成十百万级的参数就会触发。分块拼接成一个二进制字符串、最后一次性 `btoa`，
两次都在真实大小的图片上跑过。

`requireBlobs(blobs)` 是这条链路的失败关闭点：图片块存在但 Provider 没配
`blobs`（装配错误——`AnthropicOptions`/`OpenAICompatibleOptions` 都新增了可选的
`blobs?: BlobStore` 字段，`apps/desktop` 已经在 `providerFor()` 里补上，但任何
将来新增的调用方如果漏配，不该悄悄发一张空图）会在这里抛出带"内部错误"字样的
`ProviderHttpError`，与 `web-fetch.ts` 对 `pinnedHosts` 缺失的处理是同一个姿态。

### 七、OpenAI 兼容适配器：`content` 从字符串变成数组，只在真的有图片时切换

这一家平时把 `content` 拼成一整条字符串（`toWireMessages` 原有逻辑），但支持
vision 的 OpenAI 系接口要求带图片的消息把 `content` 写成
`[{type:'text',...}, {type:'image_url',...}]` 数组——两种形状不能混用。改法是
维护一个 `hasImage` 标记：一旦这条消息里出现过图片块，`content` 整体换成数组；
没有图片的普通消息**保持原来的字符串形状不变**（有对应测试断言这一点），不因为
这个包"支持了图片"就让所有历史消息的 wire 形状悄悄改变、影响不认数组 content 的
兼容端。

Anthropic 这一侧不需要这个判断——它的 `content` 从来就是数组，`image` 只是数组里
新增的一种块类型（`{type:'image', source:{type:'base64', media_type, data}}`）。

### 八、范围边界：三类块继续保持不支持，不在这轮顺手做

- **`document` 顶层块**（PDF 等）——两个适配器的 `unsupportedBlob` 继续覆盖它。
- **`ResultBlock.image`**（工具产出的图片，比如未来的截图工具）——`tool_result.content`
  里的 `image`/`document` 继续 `throw`。当前没有任何工具会产出这种内容，是安全的
  搁置而不是遗漏。
- **`document`/`image`（工具结果内）在渲染层的展示**——`BlockView` 的 `tool_result`
  分支继续走 `` `[${c.type}]` `` 占位。

三类都不需要新的设计判断，是同一条既有规则（`unsupportedBlob`/占位文本）自然覆盖
到的结果，不是本轮新引入的搁置。

## 后果

- `runTurn` 是一个公开的、被 9 个测试文件 + `apps/desktop` + headless 冒烟脚本
  调用的函数，这次是它自 M0-b 落地以来第一次改公开签名——16 处测试调用点全部
  机械替换为 `textInput(...)`，模式统一，没有语义变化。
- `packages/providers` 第一次有文件间共享的 base64 编码逻辑（`blob.ts`），两个
  适配器都从中导入，避免"两份手写编码各自漂移"。
- `AnthropicOptions`/`OpenAICompatibleOptions` 新增 `blobs?: BlobStore`——两个类都
  已经有 `capabilityOverrides`/`models` 这类可选构造项，这不是第一次扩展构造选项。
- `SendUserMessageRequest` 从 `z.strictObject` 变成带 `.refine()` 的 `ZodEffects`——
  `text` 的 `.min(1)` 移除，改由 refine 覆盖"文字与图片都为空"这一种情况，既有的
  "空字符串被拒绝"断言在新逻辑下依然成立（有回归测试）。
- 渲染层第一次有粘贴/文件处理代码（`Composer` 的 `onPaste`），也第一次反查 blob
  内容（`ImageBlockView` 用新的 `xm:read-blob` 通道）。

## 反向演练

| 演练 | 结果 |
|---|---|
| 默认（非 vision）`ScriptedProvider` + 带图片输入调 `runTurn` | 同步 `throw`，事件总线上**没有任何事件**、`runtime.state.messages` 长度为 0——不是"报了错但顺手记了一条孤立的 turn.start"（`packages/runtime/tests/multimodal.test.ts`） |
| 支持 vision 的 `ScriptedProvider` + 带图片输入 | 正常跑完，`turn.start`/`turn.end` 配对齐全，最终状态里能找到图片块（同上） |
| 不支持 documents 的 Provider + 带文档输入 | 同样在记事件之前 `throw`（同上） |
| Anthropic 适配器：图片块编码 | 捕获实际发出的 wire body，`content` 里的 base64 与手算值逐字节一致（`packages/providers/tests/adapters.test.ts`） |
| Anthropic/OpenAI 兼容：`blobs` 未配置但请求里有图片块 | 两家都抛出带"内部错误"字样的 `ProviderHttpError`，不是发一张空图或崩溃（同上） |
| OpenAI 兼容：图片块存在 | `content` 变成数组，`image_url.url` 是正确的 data URL；没有图片的普通消息 `content` 仍然是字符串（同上） |
| `document` 顶层块（两家） | 仍然失败关闭（同上，缩窄范围后的回归测试） |
| 桌面 IPC：`text` 与 `images` 都为空 | 拒绝；只发图片不带文字 | 通过（`apps/desktop/tests/ipc.test.ts`） |
| 超过 8 张图 / 单图 base64 超过上限 | 拒绝（同上） |
| `decodeImageAttachment`：超 10MB / 非 `image/*` mime | 拒绝，带具体数字/mime 的错误信息（`apps/desktop/tests/multimodal-input.test.ts`） |
| headless 冒烟：组装 → runTurn → 事件落库 → blob 落盘 | 图片真的落进 `FileBlobStore`，重开库回放出的消息里能找到同一个 `hash` 的图片块（`scripts/smoke-headless.mjs` 第四段） |

新增/扩展测试：`packages/runtime/tests/multimodal.test.ts`（新，3 条）、
`packages/providers/tests/adapters.test.ts`（新增 5 条，改写 1 条）、
`apps/desktop/tests/ipc.test.ts`（新增 6 条）、
`apps/desktop/tests/multimodal-input.test.ts`（新，4 条）、
`scripts/smoke-headless.mjs` 新增第四段反向演练。

## 遗留

- **跨轮模型兼容性审计未做**：中途换成不支持 vision 的模型、历史消息里却带着图片，
  `runTurn` 的能力闸门只查新输入，不会拦下这种情况——请求仍会打到 Provider 深处
  报错。这是 M2 `ContextBuilder`（预算分配、分层压缩）该管的事，`buildRequest()`
  的注释里已经写明"预算分配、分层压缩、缓存断点都是 M2，别在这里长出一个半成品"。
- **`document`（PDF 等）与工具产出的图片仍未实现**，见「决策八」——不是遗漏，是
  安全的搁置，真有需求（比如截图工具）时按同一套 `blobToBase64`/`requireBlobs`
  机制扩展即可，不需要重新设计。
- **多张图片、多轮对话下的 token/成本预估**没有特殊处理——`countTokens`/用量展示
  仍然只读 Provider 返回的真实值，图片消耗多少 token 完全由 Provider 侧决定，
  这与 M1-b 定下的"不自己估算"原则一致，不是这轮新引入的债。
