# `@xm/platform`

`PlatformPort` 的 **Node 实现**：操作系统识别、目录解析、能力探测。

## 这个包负责什么

| 模块 | 职责 |
|---|---|
| `src/detect.ts` | 全仓库**唯一**允许读 `process.platform` / `node:os` 的文件 |
| `src/paths.ts` | 用 `env-paths` 解析平台规范目录，产出已规范化的 `XmPaths`（ADR-0014） |
| `src/node-platform.ts` | 组装 `PlatformPort`；`withCapabilities()` 供外壳往上抬能力 |
| `src/container-services.ts` | M3-a 生产 profile 的 local `clock` / `ids` 提供者；时间与随机性不泄漏进 kernel |

## 不负责什么

- **electron**。托盘、通知、`safeStorage` 都要外壳才有，那部分在 `apps/desktop`。
  这条由 dependency-cruiser 强制：CLI（M3）与 headless 冒烟都要用本包，
  一旦泄漏 electron 依赖，它们就全起不来。
- 密钥的实际存取。`capabilities().secrets` 只报**后端是哪一种**，
  `SecretStore` 本身是 M1。

## 三条容易被破坏的约束

**一、`detect.ts` 是唯一的口子，且口子开在 `eslint.config.js` 里。**
放行是按**文件路径**开的，不是行内 `eslint-disable`。区别是扩散性：行内注释会跟着
复制粘贴一路传染，路径白名单传染不了——多放行一个文件就要多改一次配置，
那次改动在 review 里看得见，而且 `eslint.config.js` 本身被 `red.self-modify` 红线护着。

**二、能力探测报的是"地板"，不是"天花板"。**
本包只声明它自己交付得了的能力：托盘/通知/截屏一律 `false`，密钥后端是
`encrypted-file`。外壳用 `withCapabilities()` 往上抬。

反过来做（先乐观声明、由外壳往下修）的问题是：忘了修就是静默的谎报，
而谎报的表现是工具出现在模型视野里、调用之后才失败。ADR-0007 保险 2 要的
"退化时明确告知用户"，前提是没人乐观。

⚠️ `secrets` 的地板是 `encrypted-file` 而**不是** `plaintext-unavailable`：
后者的含义是"必须拒绝存密钥"，纯 Node 下口令加密文件这条路永远走得通，
谎报成不可用会让 M1 的 SecretStore 在本来能干活的环境里罢工。

**三、路径只有一个来源，且必须整份传给红线。**
`resolvePaths()` 出来的每一条都过了 `normalizedOrThrow`，与红线规则处在同一个坐标系。
到 PolicyEngine 的通路只有一条：

```ts
const platform = nodePlatform({ appRoot });
const rules = builtinRules(policyEnvFromPaths(platform.paths()));
```

不要手写其中任何一段。ADR-0012 ① 的失效就是"规则里的路径和请求里的路径各算了一次"
造成的——两边都"是路径"，匹配却永远不命中，而输出一直显示"规则已配置"。
`tests/platform.test.ts` 最后一条把这条通路整段跑了一遍。

## 相关文档

- [ADR-0007 平台支持分级](../../docs/adr/0007-平台支持分级.md)
- [ADR-0014 数据目录与平台路径](../../docs/adr/0014-数据目录与平台路径.md)
- [docs/06 §7 审计与可回滚](../../docs/06-安全与权限模型.md)
