import type { ImageAttachment } from '../shared/ipc.js';
import { MAX_IMAGE_RAW_BYTES } from '../shared/ipc.js';

/**
 * 解码一份渲染层送来的图片附件，脱离 `Services`/Electron 便于单测。
 *
 * `SendUserMessageRequest` 的 zod schema 只按 base64 字符数粗筛（膨胀系数不精确），
 * 精确的原始字节数上限在这里、解码之后再查一次——这两道闸门缺一不可：
 * 前者挡明显超标的载荷不进 JSON.parse，后者才是真正的数字。
 */
export function decodeImageAttachment(
  img: ImageAttachment,
): { readonly bytes: Buffer; readonly mime: string; readonly name?: string } {
  if (!img.mime.startsWith('image/')) {
    throw new Error(`不支持的附件类型：${img.mime}（只接受 image/*）`);
  }

  const bytes = Buffer.from(img.data, 'base64');
  if (bytes.byteLength > MAX_IMAGE_RAW_BYTES) {
    throw new Error(
      `图片${img.name === undefined ? '' : ` "${img.name}"`} 超过单图 ` +
        `${String(MAX_IMAGE_RAW_BYTES / 1024 / 1024)}MB 上限` +
        `（解码后 ${String(Math.round(bytes.byteLength / 1024 / 1024))}MB）。`,
    );
  }

  return { bytes, mime: img.mime, ...(img.name === undefined ? {} : { name: img.name }) };
}
