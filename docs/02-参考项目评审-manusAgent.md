# 02 · 参考项目评审：manusAgent（MoocManus）

评审对象：一个本地参考项目（manusAgent），约 10,275 行 Python（FastAPI + DDD 分层）+ Next.js 前端 + Ubuntu 沙箱镜像 + Nginx 网关。

**结论先行**：它的**抽象骨架值得整体继承**（六边形架构、事件驱动 UI 契约、工具集设计），它的**运行时形态必须整体推翻**（Web 多容器服务 → 本地桌面单进程组），它的**Agent 循环需要重写**（僵化状态机 + 非流式 + 单工具调用 → 统一主循环 + 流式 + 并行工具）。

---

## 一、精华：直接继承的设计

### 1.1 Ports & Adapters 分层（★★★★★）

`domain/external/*.py` 定义协议（`LLM` / `Sandbox` / `Browser` / `Task` / `MessageQueue` / `FileStorage` / `SearchEngine` / `JSONParser`），`infrastructure/external/**` 提供实现，`interfaces/service_dependencies.py` 集中装配。domain 层禁止 import infrastructure。

**继承方式**：这就是小明"一切皆插件"的基础。M0–M2 已以 Ports & Adapters 和桌面端集中装配
落地；“注册表 + 清单驱动的动态装配”仍是 M3 插件宿主目标，当前 Provider/工具生产装配仍是
显式代码，不能把目标形态写成现状。

### 1.2 事件驱动的 UI 契约（★★★★★）

`domain/models/event.py` 用 Pydantic 判别联合定义了 `plan / title / step / message / tool / wait / error / done` 八类事件，前端按类型分发渲染。这个抽象非常正确——**Agent 的输出天然是事件流而不是文本流**。

**继承方式**：已落地。共享 `@xm/contracts` 用 Zod 定义事件判别联合，前后端共用同一份类型；
当前包含 thinking delta、usage、策略审计事件、checkpoint 创建/恢复、编辑提案和 subagent 生命周期。
权限事件只记录策略拒绝，不代表仍有审批 UI。

### 1.3 工具集（ToolSet）+ 声明式 Schema（★★★★☆）

`BaseTool` 管理一组相关工具，`@tool(name, description, parameters, required)` 装饰器把方法变成 OpenAI function schema，`get_tools()` 带缓存，`invoke()` 按名反射派发。

**继承方式**：保留"工具集"这一层聚合（`file` / `shell` / `browser` 各自成组，便于按组授权和按组开关），但 Schema 用 Zod 定义并自动推导 TS 类型，避免手写 JSON Schema 与实际签名脱节。

### 1.4 沙箱作为可替换的执行后端（★★★★☆）

`Sandbox` 协议 + `DockerSandbox` 实现，file/shell 工具透传到沙箱的 HTTP API。工具代码不关心命令跑在哪。

**继承方式**：抽象为 `Executor` 端口，桌面端默认实现是**本地进程执行器**（无 Docker 依赖），可选实现为容器执行器、远程 SSH 执行器。这是小明"既能操作我的电脑，又能安全跑不信任代码"的关键开关。

### 1.5 MCP / A2A 作为工具集接入（★★★★☆）

外部 Agent 与外部工具通过统一的工具接口进入 Agent 视野，不特殊化。

**继承方式**：保留。MCP 在小明这里是**一等公民扩展点**，且要支持 stdio / SSE / streamable-http 三种传输，并支持 MCP 的 resources 与 prompts（参考项目只用了 tools）。

### 1.6 运行时可热改的配置（★★★☆☆）

`config.yaml` 每次请求实时读取，可经 API 在线修改，改动无需重启。

**继承方式**：保留"配置热生效"的体验，但存储与安全要重做（见下方糟粕 2.6）。

### 1.7 领域模型的切分（★★★☆☆）

`Session / Memory / Message / Plan / Step / File / ToolResult / Event` 划分清晰，可直接映射到小明的领域模型。

---

## 二、糟粕：必须推翻或重做的设计

> 下表是**验收清单**：小明的实现只要出现左列的做法，就是回退。

### 2.1 非流式模型调用 —— 致命

`OpenAILLM.invoke()` 用 `chat.completions.create` 阻塞拿完整响应再返回。用户在一次工具调用间隔里只能干等，看不到推理过程，也无法中途打断。

→ **小明**：模型端口只有 `stream()`，产出 `text_delta / thinking_delta / tool_call_delta / usage / stop` 事件块；支持 `AbortSignal` 随时中断；聚合成完整消息是上层的职责。

### 2.2 强制单工具调用 —— 严重限制性能

`filtered_message["tool_calls"] = message.get("tool_calls")[:1]`，并且 OpenAI 侧显式 `parallel_tool_calls=False`。读 5 个文件要 5 个来回。

→ **小明**：契约已允许工具声明 `concurrency` 与资源；截至 M2，主 Turn 和子 Agent 仍按顺序分发，
通用并行 Scheduler 尚未实现。目标仍是只读工具按资源安全并发、写操作串行并按依赖排序。

### 2.3 任务注册表在进程内存 —— 无法恢复

`RedisStreamTask._task_registry` 是进程内字典，Redis 只当消息流。因此 API 只能单副本，重启丢失所有运行中任务。

→ **小明**：会话状态 = 持久化事件流（SQLite WAL）。进程重启后，运行中的任务要么可恢复续跑，要么被明确标记为 `interrupted` 并给用户"继续/放弃"选项。**绝不允许静默丢任务。**

### 2.4 单表 JSONB 存全部事件/文件/记忆 —— 长会话必崩

`sessions` 单表用 JSONB 存 `events` / `files` / `memories`，每次追加事件都要读出整行、改、写回。会话越长，单次写入成本越高，是 O(n²) 的增长。

→ **小明**：已采用 `events` append-only 表与 `(session_id, seq)` 主键；消息、checkpoint、usage、
todo 和编辑提案都由事件 `reduce()`，没有各自的真相表。`sessions` 只作摘要投影，快照只作可删的
回放缓存；工作区索引是可重建派生库。

### 2.5 重量级外部依赖 —— 与桌面产品形态冲突

PostgreSQL + Redis + 腾讯云 COS + Docker + Nginx，五个外部依赖才能跑起来。对桌面应用是灾难。

→ **小明**：零外部依赖启动。SQLite（WAL 模式）+ 本地文件系统 + 进程内事件总线。Docker 仅作为**可选**的强隔离执行器。云存储只在用户主动开启同步时才涉及。

### 2.6 API Key 明文写进已提交的配置文件 —— 安全事故

参考项目把一份**含真实凭据的配置文件提交进了 git**，并在项目说明里专门提醒"不要外传"——
用一句叮嘱去补一个已经发生的结构性问题。凭据一旦进入 git 历史就等于泄露：改文件不够，
要重写历史；而只要有人 clone 过，就已经晚了。

> 具体是哪个文件、哪个仓库，本文刻意不写。指出位置对论证没有任何增益，
> 却会把这份评审本身变成一个指向可用凭据的路标。

→ **小明**：桌面端用 Electron `safeStorage` 调用 macOS Keychain / Windows DPAPI / Linux
libsecret，并把与本机账户绑定的密文写入配置目录；不引入已归档的 keytar。配置里只存
`{"$secret":"anthropic.apiKey"}` 引用，仓库有自有 secret 扫描 pre-commit 钩子。

### 2.7 静默过滤模型幻觉参数 —— 掩盖问题

`_filter_parameters` 用 `inspect.signature` 把模型多生成的参数直接丢掉，模型永远不知道自己错了，还会一错再错。

→ **小明**：Zod `.strict()` 严格校验，**校验失败把结构化错误作为工具结果回传给模型**，让它自我纠正。这是让模型变准的免费训练信号，丢掉太可惜。

### 2.8 Planner/ReAct 双 Agent + 固定状态机 —— 僵化且昂贵

`PlannerReActFlow` 硬编码 `IDLE → PLANNING → EXECUTING → UPDATING → SUMMARIZING → COMPLETED`。两个 Agent 各存一份记忆（同一件事的上下文存两遍），简单任务（"看下这个文件"）也要强行走一遍完整规划流程。

→ **小明**：**单一主循环**（模型 ↔ 工具），"规划"降格为工具（`todo_write` 之类）而非流程状态；复杂任务由模型自己决定是否拆解、是否派生子 Agent。子 Agent 是**能力**不是**流程阶段**。上下文只有一份主线，子 Agent 拿隔离的窗口并只回传结论。

### 2.9 无多模态通路 —— 挡死计算机操作

CLAUDE.md 明确写了："消息附件只把沙箱文件路径拼进上下文，模型看不到图片内容"。这意味着浏览器截图、GUI 操作截图对模型完全不可见。

→ **小明**：消息内容天生是 `ContentBlock[]`（`text` / `image` / `document` / `tool_result`），截图直接作为图像块进上下文。这是 computer-use 的前置条件，必须在 M1 就打通。

### 2.10 shell 执行不等待结束 —— 结果错乱

`shell_execute` 不等命令结束就返回，模型拿到的可能是上一条命令的回显，要配合 `shell_wait_process` / `shell_read_output` 才对。

→ **小明**：已分成 `shell.exec`（等待结束，返回 exit code + stdout/stderr + 截断信息）与受控
`shell.session`。后者没有原始 stdin，只用 `run(argv)` 启动一个在途程序，`status` 读取有界尾部；
暂不支持 REPL、全屏交互或任意后台输入。

### 2.11 无安全判定与恢复机制 —— 桌面端不可接受

参考项目跑在容器里，隐含"容器内随便搞"的假设。小明跑在**用户真实的电脑上**，同样的假设等于把家门钥匙交给一个会被网页内容诱导的模型。

→ **小明**：见 [06-安全与权限模型](./06-安全与权限模型.md)。现行方案不是增加审批框，而是
`allow | deny` 策略、不可覆盖红线、能力网关、写前 checkpoint 和事件审计。

### 2.12 上下文管理过于粗糙

`compact_memory()` 只是简单压缩；没有 token 预算核算，没有分层摘要，没有按需检索。

→ **小明**：M2-h 已完成近期原文 + 持久摘要、token 预算器和稳定前缀；跨会话长期记忆/检索仍属 M5。

### 2.13 无成本与用量核算

全程没有 token 统计、没有费用估算、没有速率限制处理（除了粗暴重试）。

→ **小明**：`usage` 事件贯穿全链路，按会话/按天/按 Provider 聚合展示；预算上限可配置并可硬阻断。

### 2.14 工具展示内容在编排层二次填充 —— 强耦合

`AgentTaskRunner._handle_tool_event()` 里针对每种工具类型手工塞展示内容（截图、console、文件内容），CLAUDE.md 承认"新增工具类型需要同时改这里和前端 tool-use/"。加一个工具要改三处。

→ **小明**：工具描述符和结果已有 `DisplayHint`，内建 todo/diff/checkpoint/terminal 视图已经消费各自
投影；通用渲染器注册表与插件自带渲染器仍属 M3，当前不能声称新增任意工具都无需改 UI。

### 2.15 SSE + anyio cancel scope 的坑

CLAUDE.md 记录了一堆绕坑技巧（`finally` 里的 DB 操作要丢进新 task、MCP 清理必须同 task）。这是 Web + SSE + 异步框架组合出的偶然复杂度。

→ **小明**：桌面端进程内通信用 MessagePort / 结构化 IPC，无 HTTP 断连语义；生命周期由显式的 `AbortController` + 资源作用域管理。这类坑从形态上被消除。

---

## 三、可直接搬运的资产

| 资产 | 处理方式 |
|---|---|
| `ui/docs/design/*.jpg` 17 张设计稿 | 作为 UI 信息架构参考（会话列表 / 工具预览面板 / 配置页布局），视觉风格改为 Claude Code 桌面端调性 |
| 工具预览面板、VNC 面板的信息布局 | 演化为"观察面板"：终端、浏览器、文件 diff、屏幕（computer use）四种视图 |
| 提示词（`domain/services/prompts/`） | 作为起点参考，但小明的提示词要走版本化 + 可评测（见 07 文档） |
| `sandbox/` 镜像定义 | 作为**可选**容器执行器的镜像基础，不进主链路 |

## 四、给实现者的一句话总结

> 抄它的**接口分层**和**事件契约**，重写它的**Agent 循环**，扔掉它的**运行时形态**，补上它完全没有的**权限、可恢复性、流式、多模态、成本核算**五块。
