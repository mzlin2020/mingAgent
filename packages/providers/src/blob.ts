import type { BlobRef } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type { BlobStore } from '@xm/kernel';
import { readBlob } from '@xm/kernel';
import { ProviderHttpError } from './http.js';

/**
 * 把 `ContentBlock.image` 的 `BlobRef` 编成 base64。
 *
 * 两家 wire 格式都要塞 base64，只是外层信封不同（Anthropic 的 `source` 对象 vs
 * OpenAI 兼容那一家的 data URL），编码这一步是共用的，抽出来避免两份实现各自漂移。
 */
export async function blobToBase64(blobs: BlobStore, ref: BlobRef): Promise<string> {
  return uint8ArrayToBase64(await readBlob(blobs, ref));
}

/**
 * 图片内容块存在，但这个 Provider 没配 `blobs`——这是装配错误，不是可以退化
 * 处理的输入问题（同样的姿态见 `web-fetch.ts` 对 `pinnedHosts` 缺失的处理）。
 */
export function requireBlobs(blobs: BlobStore | undefined): BlobStore {
  if (blobs === undefined) {
    throw new ProviderHttpError(
      xmError(
        'provider_error',
        '内部错误：收到图片内容块，但这个 Provider 没有配置 BlobStore，编不出 base64。',
        { retryable: false },
      ),
    );
  }
  return blobs;
}

/**
 * 只用 Web 平台 API——这个包禁止 `node:*`/`Buffer`（depcruise 规则
 * `providers-零-node内置`，`tsconfig.json` 特意只开了 DOM lib 换 `fetch`/`btoa` 这几样）。
 *
 * `String.fromCharCode(...bytes)` 直接展开在大图片上会撞调用栈的参数个数上限，
 * 分块拼接成一个二进制字符串，最后一次性 `btoa`。
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
