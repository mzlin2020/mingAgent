/**
 * 无运行时不变量：`@xm/contracts` 只有 Zod schema 与纯函数，没有可变状态，
 * 也不拥有任何事件协议——它**定义**事件的形状，而"这些事件之间该有什么关系"
 * 由消费那条流的包（kernel / runtime）拥有。
 *
 * 契约自身的正确性由 schema 校验与 `tests/registry.test.ts` 那组注册表断言覆盖，
 * 那是类型与单元测试的职责，不该搬进运行时。
 *
 * ⚠️ 这里没有 `import type { InvariantInstaller }`，因为依赖方向不允许：
 * 注册表的类型住在 `@xm/kernel`（它要引用 `SessionState`），而 kernel 依赖 contracts。
 * 一个空 installer 在结构上就是兼容的，为了标注类型把方向倒过来才是真的错。
 *
 * 重新审视的条件：如果契约包哪天长出运行时状态（例如一个跨包共享的注册表），
 * 这句理由当场失效。
 */
export const contractsInvariants = (): undefined => undefined;
