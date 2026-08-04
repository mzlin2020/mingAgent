import { z } from 'zod';
import { Capability } from '../permission/capability.js';
import { Durability } from '../event/envelope.js';

/**
 * 插件清单（M0 只放最小形状，M3 真正启用时按 docs/05 展开）。
 *
 * 现在就放进契约的唯一理由是 `contractsRange`：插件宿主要在**加载前**做兼容性检查，
 * 不兼容直接拒绝并说明原因，而不是运行到一半崩。这个字段一旦缺席，
 * 后面所有已发布的插件都拿不到版本协商能力。
 */
export const PluginManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  version: z.string(),
  /** 期望的契约协议版本范围，如 "^1.0.0"。见 docs/10 §10 */
  contractsRange: z.string(),
  /** 插件申请的能力上限；实际是否放行仍由 PolicyEngine 决定 */
  capabilities: z.array(Capability).default([]),
  /** 插件自定义事件：类型名（不含 ext.<id>. 前缀）→ 持久化层级 */
  events: z.record(z.string(), Durability).default({}),
  entry: z.string(),
  description: z.string().optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
