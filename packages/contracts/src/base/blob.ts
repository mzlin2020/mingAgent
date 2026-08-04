import { z } from 'zod';

/**
 * 内容寻址的二进制/大文本引用。
 *
 * **规则：事件与消息里永远不放二进制或大文本，只放 BlobRef。**
 * 截图、附件、超长命令输出全部进 blob 表。内容寻址意味着同一张截图在一次会话里
 * 出现十次也只存一份。
 */
export const BlobRef = z.object({
  /** sha256 十六进制小写 */
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** 原始文件名，仅展示用，不参与寻址 */
  name: z.string().optional(),
});
export type BlobRef = z.infer<typeof BlobRef>;

/** 展示用的短标识，如 `blob:sha256:ab3f1c…` */
export const formatBlobRef = (ref: BlobRef): string => `blob:sha256:${ref.hash.slice(0, 12)}…`;
