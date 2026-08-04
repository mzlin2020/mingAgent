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

/** 按分层顺序依次合并；后者覆盖前者 */
export const mergeConfigLayers = (...layers: ConfigPatch[]): ConfigPatch =>
  layers.reduce<ConfigPatch>((acc, layer) => mergeConfig(acc, layer), {});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
