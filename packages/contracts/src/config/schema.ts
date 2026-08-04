import { z } from 'zod';
import { PermissionTier, PolicyRuleSet } from '../permission/policy.js';
import { SecretRef } from './secret.js';

/**
 * 配置树（M0 最小可用版本，字段随 M1 扩展）。
 *
 * 分层与合并：
 *   内置默认 < 用户级 ~/.xiaoming/config.json < 项目级 .xiaoming/config.json
 *            < 会话覆盖 < 环境变量
 */

export const ProviderConfig = z.object({
  kind: z.enum(['anthropic', 'openai', 'openai-compatible', 'google', 'ollama']),
  baseUrl: z.string().optional(),
  /** 只能是引用，不能是明文 */
  apiKey: SecretRef.optional(),
  models: z.array(z.string()).default([]),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Config = z.object({
  /** 角色 → 模型引用，形如 "anthropic/claude-opus-5" */
  model: z.object({
    main: z.string(),
    subagent: z.string().optional(),
    summarize: z.string().optional(),
  }),
  providers: z.record(z.string(), ProviderConfig).default({}),
  permission: z.object({
    tier: PermissionTier.default('balanced'),
    /** 用户/项目自定义规则，与内置规则合并后统一求值 */
    rules: PolicyRuleSet.default([]),
  }),
  tools: z.object({
    disabled: z.array(z.string()).default([]),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** 关掉需要显式操作，且会在 UI 上常驻警告 */
    redact: z.boolean().default(true),
  }),
});
export type Config = z.infer<typeof Config>;

/**
 * 配置补丁：任意形状的 JSON，合并后再整体按 Config 校验。
 * 刻意不做成 `Config.deepPartial()`——补丁里要能出现 `null`（表示删除），
 * 那不是 Config 的合法取值。
 */
export const ConfigPatch = z.record(z.string(), z.unknown());
export type ConfigPatch = z.infer<typeof ConfigPatch>;

/**
 * 配置合并语义 —— **写死并测试**（docs/10 §8）：
 *
 * | 值类型 | 行为 |
 * |---|---|
 * | 对象 | 深合并 |
 * | 数组 | **整体替换**，不是拼接 |
 * | null | 删除该键 |
 * | 其它 | 覆盖 |
 *
 * 数组语义是最容易含糊的地方——"项目配置里的工具白名单"到底是覆盖还是追加？
 * 含糊一次就会有安全事故。选替换，因为它可预测；需要追加时用显式的字段表达。
 */
export function mergeConfig(base: ConfigPatch, patch: ConfigPatch): ConfigPatch {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // 显式删除
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete out[key];
      continue;
    }
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeConfig(prev, value);
    } else {
      // 数组走这里 —— 整体替换
      out[key] = value;
    }
  }
  return out;
}

/**
 * **会话层不得触碰的配置路径。**
 *
 * 分层里"会话覆盖"排在项目级之上，于是 `session.config` 事件的补丁天然能改任何键——
 * 包括 `permission.tier`。那意味着任何能往事件流里追加一条 session.config 的路径，
 * 都等于一条提权到 YOLO 的通道；而事件流的写入方将来会包括工具、插件宿主、
 * 以及小明自己（L4）。**权限档位与规则只能来自用户级/项目级配置文件，不能来自会话内。**
 *
 * 密钥同理：会话补丁能改 `providers.*.apiKey` 就等于能把请求导向任意端点。
 */
export const SESSION_FORBIDDEN_CONFIG_PATHS: readonly string[] = ['permission', 'providers'];

/**
 * 过滤会话级补丁里越权的键，**失败关闭**。
 *
 * 两个调用点，缺一不可：
 *   · 运行时写 `session.config` 事件**之前**——这样能把 `rejected` 变成一条 notice 事件，
 *     用户看得见"你的会话补丁有一部分被拒了"，符合"绝不静默"。
 *   · `reduce()` 里**再过一次**——历史事件、被篡改的库、旧版本写入的数据都走这条路，
 *     而 reduce 无法发事件，只能静默丢弃。两处都做，才是"写入侧告知 + 读取侧兜底"。
 */
export function restrictSessionPatch(patch: ConfigPatch): {
  patch: ConfigPatch;
  rejected: readonly string[];
} {
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (SESSION_FORBIDDEN_CONFIG_PATHS.includes(key)) {
      rejected.push(key);
      continue;
    }
    out[key] = value;
  }
  return { patch: out, rejected };
}

/** 按分层顺序依次合并；后者覆盖前者 */
export const mergeConfigLayers = (...layers: ConfigPatch[]): ConfigPatch =>
  layers.reduce<ConfigPatch>((acc, layer) => mergeConfig(acc, layer), {});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
