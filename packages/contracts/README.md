# `@xm/contracts`

小明系统里**唯一的事实来源**：事件、工具、权限、模型、配置的 Zod schema 与推导类型。

## 这个包负责什么

- 定义一切**跨进程传输**与**落库**的数据形状
- 提供纯函数：`redact()`（脱敏）、`assertToolSchema()`（工具入参子集断言）、`toModelSchema()`（JSON Schema 导出）、`createEvent()` / `parseStoredEvent()`（事件的写入与读取入口）、`mergeConfig()` / `restrictSessionPatch()`（配置合并与会话层越权过滤）

## 不负责什么

- **任何 I/O、任何状态**。没有 `async`，没有 `Promise`，没有 `node:*`（ESLint + dependency-cruiser 双重强制）
- 业务逻辑。`reduce()`、`PolicyEngine`、`ToolRegistry` 都在 `@xm/kernel`
- `interface Tool` —— 它含 `execute()`，不可序列化，属于 kernel

## 🔴 两条反直觉的规则

### 一、事件用 `looseObject`，工具入参用 `strictObject`

方向相反，**两个都是对的**：

| 场景 | 构造 | 未知字段 | 为什么 |
|---|---|---|---|
| 模型给的工具入参 | `z.strictObject()` | **报错** | 未知字段说明模型在幻觉。静默丢弃会让它以为参数生效了 |
| 落库的事件 payload | `z.looseObject()` | **保留** | 未知字段说明版本漂移。丢弃等于**永久损坏数据** |

**绝对不要用 `z.object()`。** Zod 的默认 `z.object()` 是 strip 模式——静默丢弃未知字段，不报错、不告警，数据就那样没了。它在这两个场景里都是错的：对入参太松（模型的错误被吞掉），对事件太紧（历史数据被销毁）。

会有人为了"一致性"想把事件也改成 strict，或顺手写成看起来更朴素的 `z.object()`。`tests/event-loose.test.ts` 守着这条。

### 二、`z.toJSONSchema()` 必须传 `io: 'input'`

```ts
z.toJSONSchema(schema, { io: 'input', reused: 'inline' })
//                       ^^^^^^^^^^^^ 必须
```

默认是 `io: 'output'`，而 output 视角下带 `.default()` 的字段**一律进 `required`**——模型会被告知这些可选参数是必填的，每次都得填，纯属浪费 token 且徒增出错面。

配套的坑：**不能用"导出是否抛错"当合法性检查**。`.transform()` 在 `io:'output'` 下抛错，但在我们实际用的 `io:'input'` 下静默通过；`z.any()` 导出成 `{}`；递归导出成 `{"$ref":"#"}`——三者导出全不报错。所以 `assertToolSchema()` 必须遍历 Zod 内部结构自行判定。

> ⚠️ 它读的是 Zod 的 `_zod.def`，属**半公开 API**，不受 semver 保护。因此 `zod` 在 `package.json` 里锁的是**精确版本**，升级时 `tests/tool-schema.test.ts` 是回归闸门。

## 🔴 第三条：事件的写入只走 `createEvent()`

读取路径（`parseStoredEvent`）一开始就有校验、upcaster、未知类型报错；写入路径如果是"手工拼一个对象字面量"，`v` 就全靠人记得填对。**事件一旦落库就是永久的**——`v` 写错会让日后的 upcaster 跑在错误的数据上，且要等到几个版本之后才暴露。

`createEvent()` 的 `v` **从注册表取且不接受调用方传入**，payload 当场校验。见 `tests/event-write-path.test.ts`。

对称的一条：`v` 高于本机支持版本的事件**必须抛错**，不能降级解释。`looseObject` 保留未知字段解决的是"字段丢失"，解决不了"字段语义变了"——旧代码按 v1 的理解读 v2 的数据，会得到一个看起来正常、实际错误的状态（ADR-0012 ⑤）。

## 目录

```
src/
├── base/       ids 品牌类型 / error 错误码 / blob 内容寻址 / redact 脱敏
├── content/    block 内容块 / message 消息
├── session/    todo 任务清单
├── event/      envelope 信封+seq 不变量 / payloads 全部事件 / registry 注册表 / index 判别联合+解析
├── tool/       descriptor 描述符 / result 截断契约 / display 展示契约 / claim 资源声明 / schema 子集断言
├── permission/ capability 能力闭集 / request 请求+信任级别 / policy 规则与判定
├── model/      request 请求+缓存断点 / chunk 流式块 / usage 用量
├── config/     secret 密钥引用 / schema 配置树+合并语义+会话层越权过滤
└── plugin/     manifest 插件清单
```

`event/payloads.ts` 约 400 行。docs/01 原则七的「单文件 400 行触发审查」在这里是**合理例外**：它是同质列表，可读性不随长度劣化，拆开反而要在多个文件间跳。

## 工具链

`npx tsc` 是 TS 7.0 原生二进制，`require('typescript')` 是 TS 6.0 的 JS API（typescript-eslint 用）。别名双装，见 [ADR-0010](../../docs/adr/0010-TypeScript双编译器工具链.md)。写契约时保持类型简单——typed lint 是 CI 最慢的一环，收益直接体现在 CI 时间上。

## 相关文档

- [docs/10 契约设计](../../docs/10-契约设计.md) —— 本包的实现级规格
- [ADR-0008](../../docs/adr/0008-事件持久化分层与演进.md) —— 持久/瞬态分层与演进
- [ADR-0009](../../docs/adr/0009-工具Schema子集与结果截断.md) —— 工具 schema 子集与截断
