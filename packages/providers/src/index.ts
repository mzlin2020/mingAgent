/**
 * `@xm/providers` —— `ModelProvider` 的各家实现。
 *
 * **只用 Web 平台 API**（fetch / AbortController / TextDecoder / ReadableStream），
 * 不 import 任何 `node:*`，也不认识 electron。两条 depcruise 规则钉着这一点。
 *
 * 这个限制不是洁癖：它保证「换外壳」与「跑在浏览器/Worker 里」这两条退路一直开着，
 * 而且顺带堵死了一个具体的坏路径——包里读不到 `process.env`，
 * 于是**密钥的唯一来源只能是调用方传进来的 `apiKey`**，而那个值只能来自 SecretStore。
 */

export * from './sse.js';
export { ProviderHttpError, postSse } from './http.js';
export type { HttpDeps, PostSseOptions } from './http.js';
export { AnthropicProvider } from './anthropic.js';
export type { AnthropicOptions } from './anthropic.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
export type { OpenAICompatibleOptions } from './openai-compatible.js';
export { capabilitiesFor, CONSERVATIVE_CAPABILITIES } from './catalog.js';
export { buildToolNameCodec } from './tool-name.js';
export type { ToolNameCodec } from './tool-name.js';
