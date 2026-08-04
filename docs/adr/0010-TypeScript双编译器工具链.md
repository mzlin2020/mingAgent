# ADR-0010 · TypeScript 双编译器工具链：TS 7 编译 + TS 6 供 API

- **状态**：🟢 Accepted
- **日期**：2026-08-04
- **相关**：[ADR-0001](./0001-桌面技术栈选型.md)（细化其"补充决策：TypeScript 版本选 7.0"）、[03-技术选型 §4.1](../03-技术选型.md)、[10-契约设计](../10-契约设计.md)
- **依据**：2026-08-04 实机冒烟验证，环境 Node 22.23.2 / Linux x64

## 背景

[ADR-0001](./0001-桌面技术栈选型.md) 选定 TypeScript 7.0，并把"编译器 API 成熟度"列为 M0 头号验证风险。本 ADR 记录实测结果并给出可执行的工具链形态。

**实测确认**：`typescript@latest` = **7.0.2**，TS 7.0 确已发布。

**但核心风险已兑现**——TS 7.0 是 Go 原生移植，以平台二进制分发（`optionalDependencies` 里 20 个 `@typescript/typescript-<os>-<arch>` 包），且**不提供 JS 编译器 API**：

```
$ node -e "const ts=require('typescript'); console.log(Object.keys(ts))"
[ 'version', 'versionMajorMinor' ]        # createProgram / SyntaxKind 全部 undefined
```

官方公告原文：*"TypeScript 7.0 does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API."*

后果是一切依赖 `require('typescript')` 的工具全部失效。typescript-eslint 是硬失败，且给出明确信息：

```
typescript-eslint does not support TS 7.0.
See https://github.com/typescript-eslint/typescript-eslint/issues/10940
for tracking typescript-eslint's support for TS >=7.1
```

typed lint 是我们原则四（严格校验、禁止 `any`）的主要执行手段，不能放弃。

## 选项

### A. 回退到 TS 6.x，等 7.1 生态成熟
- 优点：工具链零风险
- 缺点：放弃 2.1x 的类型检查提速；且迟早要迁，晚迁不会更便宜

### B. 只用 TS 7，放弃 typed lint
- 优点：工具链最简单
- 缺点：**不可接受**。放弃 typed lint 等于放弃原则四的自动化执行

### C. 双编译器并存：TS 7 负责编译，TS 6 供工具用 API
- 优点：两边的好处都拿到；是官方给出的过渡方案
- 缺点：两个编译器版本要保持同步；概念上多一层

## 决策

选择 **C**，采用官方的别名双装机制：

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

- `npx tsc` → **7.0.2 原生二进制**（类型检查、d.ts、`--build`、`--watch`）
- `require('typescript')` → **6.0.x 完整 JS API**（typescript-eslint、api-extractor、ts-morph、编辑器 tsserver）

**实测结果（201 文件 / 16,399 行，zod 重类型推导负载）**：

| 项 | 结果 |
|---|---|
| `tsc --noEmit` strict 全开 | ✅ |
| 穷尽性检查（`never` 兜底） | ✅ 正确触发 TS2345 |
| d.ts + declarationMap，品牌类型保真 | ✅ |
| `tsc --build` 项目引用（monorepo 必需） | ✅ 全量 0.25s，增量命中缓存 0.07s |
| `tsc --watch` 增量与错误恢复 | ✅ |
| pnpm workspace + 别名双装 | ✅ |
| typed lint（`strictTypeChecked`，走 TS 6 检查器） | ✅ 可用，并真实抓出设计缺陷 |
| **TS 7 类型检查** | **8.6s** |
| **TS 6 类型检查（同代码）** | **17.9s** → 提速 **2.1x** |
| **typed lint（同代码）** | **26.4s / 峰值 1.41GB** |
| 两编译器对含错代码的结论 | ✅ 4 个错误、错误码、数量**完全一致** |

## 后果

**正面**
- 类型检查提速 2.1x，且 `--build` / `--watch` / 项目引用在 monorepo 下全部可用，M0 的骨架无需绕路
- typed lint 完整保留。冒烟中它立刻抓出契约设计里的一个真实缺陷（`newId<T>()` 的类型参数只用一次 = 伪装的类型断言），证明这条防线值钱
- 两编译器结论一致，意味着"lint 用 6、构建用 7"不会出现一边过一边不过的撕裂

**负面**
- **提速的实际收益被 lint 稀释**。CI 的类型相关耗时由 lint 主导（26.4s）而非编译（8.6s），采用 TS 7 把总耗时从约 44s 降到约 35s，是 1.26x 而非 2.1x
- typed lint 峰值 1.41GB，在 CI 上要注意容器内存限额，且这个数字随代码量线性增长
- 两个版本号要一起升，升级窗口受较慢的一方约束
- **退出码不一致**：同样的错误，`tsc --noEmit` 下 TS 7 退出 `1`、TS 6 退出 `2`；而 **build 模式（`tsc -b`）下 TS 7 退出 `2`**（2026-08-04 M0-a 实现期实测，见 [ADR-0011 ⑦](./0011-契约与内核实现期的偏离.md)）。结论不变、反而更强：**CI 脚本一律只判断"非零"，禁止判断具体值**
- `tsc --version` 在两处含义不同，新人容易困惑

**缓解措施**
- CI 里 lint 与 typecheck 并行跑，让总耗时取 max 而非 sum
- lint 按 turbo 缓存 + 仅变更包增量执行，全量 lint 只在主干跑
- 版本升级写成一条 renovate/dependabot 规则，两个别名绑定升级
- 在根 `README` 与 `packages/*/README` 里用一句话说明双装机制，避免每个新人踩一次

**重新评估的触发条件**
- **TS 7.1 发布并提供新 API，且 typescript-eslint 完成适配**（追踪 [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)）→ 立刻去掉 TS 6，改为单版本。这是本 ADR 的预期终局
- typed lint 内存或耗时在 CI 上成为实际阻塞 → 考虑把类型感知规则集收窄到核心包
