import { z } from 'zod';
import { BlobRef } from '../base/blob.js';

/**
 * 工具自带展示契约。
 *
 * 参考项目 2.14 的教训：展示信息在编排层按工具名 if-else 填充，每加一个工具都要改内核。
 * 这里反过来——工具自报 renderer ID，编排层完全不认识具体工具。
 *
 * **降级路径必须存在**：找不到对应渲染器时降级为纯文本 `summary`。
 * 否则三方插件贡献的工具会让 UI 白屏，而这是我们无法在发布前测到的组合。
 */
export const DisplayHint = z.object({
  /** 渲染器 ID，见 docs/05 的渲染器注册表 */
  renderer: z.string(),
  /** 一行摘要，折叠态显示；也是渲染器缺失时的兜底内容 */
  summary: z.string(),
  /** 渲染器自己的 payload，核心不解释 */
  data: z.unknown(),
  /** 截图 / 大文件 */
  blobs: z.array(BlobRef).optional(),
});
export type DisplayHint = z.infer<typeof DisplayHint>;
