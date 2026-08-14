# M3-a 测试方案 · 容器与效果

**日期**：2026-08-14
**范围**：只验证 `@xm/kernel/src/container/`、确定性 `clock` / `ids` 与 platform local 提供者；
不接 runtime / desktop，不改变 M0–M2 用户行为。

## 1. 自动化验收面

| 验收面 | 关键断言 |
|---|---|
| 服务与插件 | `inject` / `provide` 与注册顺序无关；未声明、漏提供、同层双提供均失败关闭 |
| 装配收敛 | 缺少提供者指名插件/服务；依赖环打印完整链；阶段中途失败整体回滚 |
| 效果 | 插件卸载后服务、监听器、fork 与普通效果全部消失；同所有者按 LIFO 撤销 |
| 四种派发 | `emit` 同步注册序；`serial` 有序 bail；`waterfall` await/短路/重入；`parallel` 全部结算后聚合错误 |
| 错误与取消 | serial / waterfall 错误原样上抛；永不 resolve 的 waterfall 可由 `AbortLike` 打断 |
| 两级扁平作用域 | 孙层看根层与自己、看不到父 fork 局部注册；解析扁平但生命周期仍级联 |
| 确定性服务 | 固定起点/步进/advance；全类型递增 UUIDv4；稳定的 `ctx.clock` / `ctx.ids` 属性 |
| local 提供者 | platform 时钟保持 epoch ms；各 ID 入口保持现有 UUIDv4 行为 |
| 架构边界 | kernel 零 `node:*`；生产文件均小于 400 行；依赖图无新增违规 |

定向入口：

```powershell
pnpm exec vitest run `
  packages/kernel/tests/container-services.test.ts `
  packages/kernel/tests/container-events.test.ts `
  packages/kernel/tests/container-scope.test.ts `
  packages/kernel/tests/container-determinism.test.ts `
  packages/platform/tests/container-services.test.ts
```

## 2. 必做反向演练

1. 新测试在实现前先跑：容器 API 不存在，4 个文件 23 项全部红。
2. 临时在 `packages/runtime/src/index.ts` 加一处裸 `Date.now()`：
   `check-determinism-boundary.mjs` 必须指名该文件并失败；确认后立即移除。
3. 删除插件卸载路径中的任一撤销动作：服务或监听器残留用例必须红。
4. 把 fork 解析改成沿父链继承：孙层读到父 `local` 的用例必须红。
5. waterfall 不等待监听器或不监听 abort：短路/取消用例必须红。
6. parallel 改成 `Promise.all` 短路：第二观察者完成的断言必须红。

第 3～6 项由对应单元用例持续执行；第 1、2 项在本阶段现场实际演练并记录输出。

## 3. 总闸门

阶段收官运行根目录 `pnpm verify`。验收标准是与
[M3 实施前基线](./基线记录.md) 相同的全部闸门继续通过，且新增确定性边界检查进入该命令。

本阶段没有桌面行为变化，不安排 GUI 人工验收；以 headless smoke 的事件数、回放等价性与
M2-b～M2-i 链路全部不变作为行为零变化证据。
