/**
 * `@xm/contracts` —— 小明系统里唯一的事实来源。
 *
 * 两条**反直觉**的规则，改代码前务必读 README：
 *   1. 事件 payload 用 `z.looseObject()`，工具入参用 `z.strictObject()`——方向相反，都是对的
 *   2. `z.toJSONSchema()` 必须传 `io: 'input'`
 */

// ── 基础 ──
export * from './base/ids.js';
export * from './base/error.js';
export * from './base/blob.js';
export * from './base/redact.js';

// ── 内容与消息 ──
export * from './content/block.js';
export * from './content/message.js';

// ── 会话 ──
export * from './session/todo.js';
export * from './session/edit.js';

// ── 还原点 ──
export * from './checkpoint/manifest.js';

// ── 事件（含信封、payload、注册表、解析入口）──
export * from './event/index.js';

// ── 工具 ──
export * from './tool/descriptor.js';
export * from './tool/result.js';
export * from './tool/card.js';
export * from './tool/origin.js';
export * from './tool/claim.js';
export * from './tool/schema.js';

// ── 权限 ──
export * from './permission/capability.js';
export * from './permission/request.js';
export * from './permission/policy.js';

// ── 模型 ──
export * from './model/request.js';
export * from './model/chunk.js';
export * from './model/usage.js';
export * from './model/price.js';

// ── 配置 ──
export * from './config/secret.js';
export * from './config/schema.js';

// ── 插件 ──
export * from './plugin/manifest.js';

/**
 * 协议版本。不只是包版本——插件清单的 `contractsRange` 与主/渲染进程握手都用它。
 * 破坏性变更（改事件 payload 语义、删能力词条）走 major，且必须同时提供 upcaster。
 */
export const CONTRACTS_VERSION = '0.1.0';

export * from './invariant.js';
