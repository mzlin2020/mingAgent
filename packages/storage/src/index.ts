/**
 * `@xm/storage` —— `EventStore` 与 `BlobStore` 端口的 SQLite / 文件落地。
 *
 * 端口与不变量都在 `@xm/kernel`；这里只有实现。**不依赖 electron**：
 * CLI（M3）与 headless 冒烟都要用它，depcruise 有一条规则盯着。
 */

export * from './schema.js';
export * from './sqlite-event-store.js';
export * from './file-blob-store.js';
export * from './open-store.js';
