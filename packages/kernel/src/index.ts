/**
 * `@xm/kernel` —— 纯逻辑内核。
 *
 * 零 I/O、零 `node:*`、零 electron（dependency-cruiser 在 CI 强制）。
 * 可以在浏览器、Node、测试里以完全相同的方式运行——这是"内核单测无需网络与
 * 文件系统"以及"未来换外壳"这两件事共同的前提。
 */

export * from './state/session-state.js';
export * from './state/reduce.js';
export * from './state/orphan.js';
export * from './state/live-buffer.js';
export * from './state/seq.js';
export * from './state/snapshot.js';

export * from './policy/engine.js';
export * from './policy/defaults.js';
export * from './policy/self-code.js';
export * from './policy/redline-projection.js';
export * from './policy/layers.js';
export * from './policy/target.js';
export * from './policy/host-target.js';
export * from './policy/ip-range.js';
export * from './policy/command-target.js';
export * from './policy/command-claims.js';
export * from './policy/normalize.js';

export * from './port/platform.js';
export * from './port/model-provider.js';
export * from './port/secret-store.js';
export * from './port/tool-gateway.js';
export * from './port/checkpointer.js';
export * from './port/workspace-index.js';

export * from './model/cost.js';

export * from './port/event-store.js';
export * from './port/execution-world.js';
export * from './port/code-runtime.js';
export * from './port/summary-projection.js';
export * from './port/memory-event-store.js';
export * from './port/event-store-contract.js';

export * from './port/blob-store.js';
export * from './port/abort.js';
export * from './port/memory-blob-store.js';
export * from './port/blob-store-contract.js';

export * from './tool/types.js';
export * from './tool/registry.js';
export * from './tool/truncate.js';
export * from './tool/present.js';

export * from './trace/derive-trace.js';

export * from './introspect/invariant.js';
export * from './invariant.js';

export * from './plugin/ext-event.js';
export * from './plugin/ext-record.js';

export * from './container/index.js';
