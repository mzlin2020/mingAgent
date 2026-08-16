/**
 * `@xm/code-runtime` —— Code Mode 的隔离提供者（ADR-0069）。
 *
 * 它实现 `@xm/kernel` 的 `CodeRuntime` 端口，**不认识工具、不认识会话、不认识权限**。
 * 程序调工具时回到宿主重走十二步链，那条路在 `@xm/runtime` 里。
 *
 * 与 `@xm/tools-core` 一样是**可整包移除**的：不装它，`ctx.codeMode` 缺席，
 * `run_code` 不注册，其余一切照常——Code Mode 本来就是 opt-in（ADR-0061 §二）。
 * depcruise 因此禁止 kernel / runtime / storage / platform 认识本包。
 */
export * from './protocol.js';
export * from './quickjs.js';
export * from './invariant.js';
