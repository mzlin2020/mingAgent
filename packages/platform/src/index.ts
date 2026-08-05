/**
 * `@xm/platform` —— `PlatformPort` 的 Node 实现。
 *
 * 平台差异在这里到头（ADR-0007 保险 1）：再往上的任何代码都不该知道自己跑在哪个系统上。
 * 本包**不依赖 electron**，因为 CLI 与 headless 冒烟都要用它（depcruise 强制）。
 */

export * from './detect.js';
export * from './paths.js';
export * from './node-platform.js';
