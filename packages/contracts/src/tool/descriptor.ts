import { z } from 'zod';
import { Capability } from '../permission/capability.js';
import { ResultLimits } from './result.js';

export const RiskLevel = z.enum(['safe', 'low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * 工具的**可序列化**描述。
 *
 * 带 `execute()` 的 `interface Tool` 留在 @xm/kernel——它含函数，不可序列化，跨不了进程。
 * **跨进程的是描述符，不是工具本身。** 这条分界让插件工具、MCP 工具、内置工具
 * 在注册表里长得完全一样，是"一切皆插件"能落地的关键。
 */
export const ToolDescriptor = z.object({
  /** 形如 "fs.read"、"browser.click"。分组前缀是强制的，便于策略按前缀匹配 */
  name: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
  group: z.string(),
  /** 提示词的一部分，计入 token 预算，所以有上限 */
  description: z.string().max(4096),
  /** JSON Schema，由 toModelSchema() 从 Zod 导出。见 tool/schema.ts */
  inputSchema: z.unknown(),
  risk: RiskLevel,
  capabilities: z.array(Capability),
  concurrency: z.enum(['parallel', 'exclusive']),
  resultLimits: ResultLimits,
  /**
   * 来源。两个用处：
   *  1. 权限 UI 要显示"这个工具来自哪个三方 MCP server"
   *  2. 注入防御要对非 builtin 来源的工具结果做不可信标记（docs/06）
   */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin') }),
    z.object({ kind: z.literal('plugin'), pluginId: z.string() }),
    z.object({ kind: z.literal('mcp'), serverId: z.string() }),
  ]),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;
