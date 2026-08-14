# ADR-0059 · 组合配置：profile 与 patch 层

- **状态**：🟢 Accepted
- **日期**：2026-08-14
- **相关**：[ADR-0052](./0052-插件容器与效果模型.md) · [ADR-0053](./0053-微内核的特权底座与扩展点边界.md) · [ADR-0023](./0023-权限规则的分层覆盖.md) · [ADR-0014](./0014-数据目录与平台路径.md)

## 背景

有了容器（ADR-0052）之后，"装哪些插件、按什么顺序装"需要一个表达方式。

现状是：`apps/desktop/src/main/services.ts` 一个函数从头接到尾，1043 行。
headless 冒烟是 `scripts/` 下另一条独立实现，`xm` CLI 不存在，评测运行器（原 M5）
将来还需要第四种装配。**同一套引擎至今没有被第二次装配过**——
"内核可被装配"这条设计目标，除了单元测试之外没有任何证据。

参考实现用 profile（有序 bundle 列表）+ 逐层 patch 表达组合，并提供
`dsh --profile web --dump-config` 打印实际启动的树。它还把 bundle 做成可分发格式，
让三方能整包插入配置行——那部分属于扩展生态，小明留到新 M4。

## 选项

### 选项 A：不做 profile，四个入口各写一份装配代码

优点：直白。
缺点：四份装配会漂移。desktop 上修的 bug，headless 上还在；
"删掉所有业务插件应用仍能启动"这条验收无处执行。

### 选项 B：一个装配函数 + 一堆布尔开关

优点：一份代码。
缺点：开关的组合空间指数增长，且表达不了顺序；插件多了之后
`if (opts.enableGit && !opts.headless)` 这类条件会遍地都是。

### 选项 C：profile（有序插件行）+ patch（按 id 覆盖或插入）

## 决策

**选择 C，但只做两层，不做可分发 bundle。**

### 一、profile 是一份有序的插件行

```jsonc
// 内建，随代码走，不在用户目录里
{
  "name": "desktop",
  "rows": [
    { "id": "baseline.policy",   "plugin": "@xm/kernel#policyGate" },
    { "id": "baseline.gateway",  "plugin": "@xm/tool-runtime#gateway" },
    { "id": "baseline.secrets",  "plugin": "@xm/platform#secretStore" },
    // …基线层，见下…
    { "id": "tools.fs",          "plugin": "@xm/tools-core#fsTools" },
    { "id": "tools.git",         "plugin": "@xm/tools-core#gitTools",  "config": { } },
    { "id": "ui.desktop",        "plugin": "@xm/desktop#shell" }
  ]
}
```

内建 profile（**M3 实现前三个**，后两个只预留位置）：

| profile | 用途 | 与今天的对应 | M3 是否实现 |
|---|---|---|---|
| `desktop` | Electron 桌面应用 | `services.ts` | ✅ |
| `headless` | 无 GUI 跑完整会话 | `pnpm smoke` 的独立脚本 | ✅ |
| `cli` | `xm` 命令行（新 M4 产品化，M3 先能跑通） | 不存在 | ✅ |
| `test` | 确定性时钟与 id，供行为快照比对（[ADR-0066](./0066-时钟与ID的注入.md)） | 不存在 | ✅ |
| `eval` | 评测运行器批量跑任务（新 M6） | 不存在 | ❌ 预留 |

各 profile 共享同一份基线层与绝大多数业务行，差异只在 UI/入口那几行。
**这就是"引擎被第二次装配"的证据**，而且是每天都在跑的证据（headless 冒烟在 `pnpm verify` 里）。

### 二、patch 只有一层，来自用户配置目录

```
${paths.config}/profiles/<name>.patch.json
```

patch 能做两件事：**按 `id` 替换某一行的 `config`**，或**插入新行**（指定插在谁之前/之后）。
不能做的是：删除基线层的行、替换基线层的 `plugin`、重排基线层的相对顺序。

层序：`内建 profile` → `用户 patch`。**刻意只有两层**——ADR-0023 已经为
`permission.rules` 定过分层语义，那里三层（内置默认 < 用户级 < 项目级）是因为
"项目层躺在别人的仓库里"这个真实威胁。装配没有这个威胁，
**项目目录不参与装配**：一个仓库不能通过 `.xiaoming/` 决定小明装哪些插件。
这一条是安全边界，不是简化。

### 三、基线层不可 patch

ADR-0053 的六项底座对应的插件行标记为基线，`id` 以 `baseline.` 开头。
容器在装配收敛时断言它们在位且未被替换，缺失或被冒充即**拒绝启动**并指名缺哪一项。

### 四、`--dump-config`

任何入口都支持打印实际装配的行（含 patch 生效后的最终配置，密钥经 `redact()`）。
这是排查"为什么这个能力没生效"的第一现场，也是让 profile 这层可被检验的最低要求。

### 五、新增包 `@xm/compose`

承载 profile 解析、patch 合并、内建 profile 定义、装配期断言。
它是**唯一**同时认识 `@xm/runtime`、`@xm/tool-runtime` 与 `@xm/tools-core` 的包
（除 `apps/desktop` 外）。**它对 `@xm/tools-core` 的依赖必须是可拆的**——
删掉工具包 + 换一份不含工具行的 profile，`@xm/compose` 仍要能编译通过
（[ADR-0063](./0063-安全底座与工具实现的包边界.md) §五）。

depcruise 新增规则两条：

- `@xm/compose` 不得依赖 electron。
- 除 `apps/**` 外，没有包可以依赖 `@xm/compose`（它是装配层，谁都不该反向依赖它）。

包数 8 → 9。**不为插件新建细粒度包**（ADR-0052 的对策一），插件住在各自现有的包里，
由包导出，profile 只写引用。

> **2026-08-14 修订（[ADR-0063](./0063-安全底座与工具实现的包边界.md)）**：包数是 8 → **10**。
> 本 ADR 把基线行 `baseline.gateway` 指向 `@xm/tools-core`，而 `@xm/compose` 又依赖它——
> 结果是"删掉 `packages/tools-core` 仍能启动"（`docs/01` 原则二的可检验约束）
> 在结构上不可能成立，M3 的 DoD 因此被写成了更弱的"删掉业务插件行"。
> ADR-0063 把网关、checkpoint 与 local 执行世界提供者迁进新包 `@xm/tool-runtime`，
> 基线行改指该包，原则二那条约束第一次可以真的跑。

### 六、不做的

- **可分发 bundle 格式**：三方整包插入配置行属于扩展生态，留新 M4，与三方隔离方案一起定。
- **配置里的表达式求值**（参考实现的 `!!js`）：一个能在配置里跑代码的机制，
  与"密钥只从 SecretStore 来"和"三方内容不可信"两条都冲突。要条件装配就多做一个 profile。

## 后果

- **正面**：`services.ts` 从 1043 行拆成插件行 + 少量 IPC 桥。四个入口共享一条装配路径，
  desktop 上修的 bug 自动覆盖 headless 与 CLI。
- **正面**："删掉所有业务插件行，应用仍能启动、工具列表为空"这条 `docs/05` 的验收测试，
  第一次可以真的跑（改一个 profile 就行）。

- **负面**：多一个概念（profile）与一个包。用户排查问题时要知道 `--dump-config`。
  缓解：`--dump-config` 与自检面板（`self-check.ts` 已有）打通，UI 上能看到装了什么。
- **负面**：patch 用 `id` 定位，重命名一行的 `id` 会静默让用户的 patch 失效。
  缓解：patch 里出现未知 `id` 时**报错而不是忽略**——"misconfiguration fails loud"，
  与 ADR-0057 未声明事件即拒绝是同一个形状。

- **代价与缓解**：`eval` profile 在新 M6 之前没有真实消费者，属于"未开工不建空目录"的边界。
  缓解：M3 只定义 `desktop` / `headless` / `cli` 三份；`eval` 等评测运行器真正开工时再加，
  本 ADR 只把它的位置留出来。

- **必做的反向演练**：
  1. patch 试图删除 `baseline.policy` → 拒绝启动。
  2. patch 试图把 `baseline.gateway` 的 plugin 换成一个空实现 → 拒绝启动。
  3. 在项目目录放一份 `.xiaoming/profile.patch.json` → **必须完全不生效**
     （项目目录不参与装配）。这一条是安全边界，要专门演练。
  4. patch 引用一个不存在的 `id` → 报错，不静默忽略。
  5. 删掉全部业务行只留基线 → 应用启动、工具列表为空、UI 有明确提示。

- **重新评估条件**：如果 profile 的行数增长到需要"组"这个概念（几十行且明显分簇），
  再引入参考实现的 bundle 层；在那之前，一层有序行 + 一层 patch 是够用的最小结构。
