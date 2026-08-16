/**
 * `@xm/runtime` —— 装配层。
 *
 * 把内核（纯逻辑）、存储（端口实现）、Provider 与工具拼成一个可运行的 headless 引擎。
 * **不依赖 electron**：`apps/cli`（M3）与 headless 冒烟都要用它，depcruise 强制。
 *
 * 那条 depcruise 规则从 M0-a 就写着，但直到本包出现之前，它指向的目录并不存在——
 * 规则从写下起一次也没匹配过任何模块。这正是「规则可能生效了但没长在攻击路径上」
 * 的教科书形态（ADR-0011 / ADR-0012 的纪律），所以本包落地时补了一次故意违规演练。
 */

export * from './event-bus.js';
export * from './session-runtime.js';
export * from './drain-text.js';
export * from './session-title.js';
export * from './turn.js';
export * from './agent.js';
export * from './turn-events.js';
export * from './turn-extension-host.js';
export * from './turn-plugins.js';
export * from './turn-request.js';
export * from './turn-sink.js';
export * from './turn-code.js';
export * from './code-sdk.js';
export * from './context-builder.js';
export * from './subagent.js';
export * from './crash-recovery.js';
export * from './card-action.js';
export * from './ext-recorder.js';
export * from './invariant.js';
export * from './invariant-install.js';
export * from './scan-invariants.js';
export * from './provider/scripted.js';
export * from './tools/demo.js';
export * from './tools/todo.js';
export * from './tools/result-expand.js';
export * from './tools/run-code.js';
