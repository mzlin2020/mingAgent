import type { BlobRef, ResultBlock, ResultLimits } from '@xm/contracts';
import { formatBlobRef } from '@xm/contracts';

/**
 * 结果截断（docs/10 §5.3 / ADR-0009）。
 *
 * **由运行时统一执行，不由工具自觉。** 工具返回全量，这里按上限截断、把全文交给
 * blob 存储、并在截断处插入**对模型可见**的标记。
 *
 * 悄悄截断是最坏的做法——模型会基于残缺内容自信地下结论，而这种错误极难归因：
 * 它看起来像模型能力问题，实际是我们喂了半截数据。
 */

export interface TruncateOutcome {
  readonly blocks: ResultBlock[];
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly originalLines: number;
  readonly keptBytes: number;
}

/**
 * `TextEncoder` 与 `crypto` 同理：它是全局的，但类型来自 DOM / @types/node，
 * 两者都不该被内核引入（会让 document / fs 在编译期变得可见）。就地声明最小形状。
 */
const encoder = new (
  globalThis as unknown as {
    TextEncoder: new () => { encode(s: string): { length: number } };
  }
).TextEncoder();

const byteLength = (s: string): number => encoder.encode(s).length;

export function truncateResult(
  blocks: readonly ResultBlock[],
  limits: ResultLimits,
  fullRef?: BlobRef,
): TruncateOutcome {
  const texts = blocks.filter((b) => b.type === 'text');
  const others = blocks.filter((b) => b.type !== 'text');

  const joined = texts.map((b) => b.text).join('\n');
  const originalBytes = byteLength(joined);
  const originalLines = joined === '' ? 0 : joined.split('\n').length;

  const overBytes = limits.strategy !== 'none' && originalBytes > limits.maxBytes;
  const overLines =
    limits.strategy !== 'none' && limits.maxLines !== undefined && originalLines > limits.maxLines;

  if (!overBytes && !overLines) {
    return {
      blocks: [...blocks],
      truncated: false,
      originalBytes,
      originalLines,
      keptBytes: originalBytes,
    };
  }

  const kept = applyLimits(joined, limits);
  const keptBytes = byteLength(kept);
  const marker = buildMarker(originalBytes - keptBytes, originalLines, fullRef);

  return {
    // 文本被合并成一块。混合结果（文本 + 图片）在实践中罕见，
    // 合并换来的是"截断只有一处、标记只有一条"这个可预期的行为。
    blocks: [{ type: 'text', text: insertMarker(kept, marker, limits.strategy) }, ...others],
    truncated: true,
    originalBytes,
    originalLines,
    keptBytes,
  };
}

function applyLimits(text: string, limits: ResultLimits): string {
  let out = text;

  if (limits.maxLines !== undefined) {
    const lines = out.split('\n');
    if (lines.length > limits.maxLines) {
      out = pickEnds(lines, limits.maxLines, limits.strategy).join('\n');
    }
  }

  if (byteLength(out) > limits.maxBytes) {
    out = trimToBytes(out, limits.maxBytes, limits.strategy);
  }

  return out;
}

/** 头/尾/两端各取一部分。`middle` 策略下头部略多——命令输出的上下文通常在前面。 */
function pickEnds<T>(items: readonly T[], budget: number, strategy: string): T[] {
  if (budget >= items.length) return [...items];
  if (strategy === 'head') return items.slice(0, budget);
  if (strategy === 'tail') return items.slice(items.length - budget);

  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return tail === 0 ? items.slice(0, head) : [...items.slice(0, head), ...items.slice(-tail)];
}

function trimToBytes(text: string, maxBytes: number, strategy: string): string {
  if (strategy === 'head') return headBytes(text, maxBytes);
  if (strategy === 'tail') return tailBytes(text, maxBytes);
  const head = Math.ceil(maxBytes / 2);
  return headBytes(text, head) + tailBytes(text, maxBytes - head);
}

/**
 * 按**字节**上限取前缀。
 *
 * 刻意不把字符串摊成数组（`[...s]` 会拆开 emoji 的组合序列，`.split('')` 会拆开代理对）。
 * 这里用 UTF-16 下标 + 比例估算 + 回退，并保证不留下孤立的高位代理项。
 */
function headBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const total = byteLength(text);
  if (total <= maxBytes) return text;

  let end = Math.max(1, Math.floor((text.length * maxBytes) / total));
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end--;
  while (end < text.length && byteLength(text.slice(0, end + 1)) <= maxBytes) end++;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

/** 按字节上限取后缀，保证不以孤立的低位代理项开头 */
function tailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const total = byteLength(text);
  if (total <= maxBytes) return text;

  let start = Math.min(text.length, text.length - Math.floor((text.length * maxBytes) / total));
  while (start < text.length && byteLength(text.slice(start)) > maxBytes) start++;
  while (start > 0 && byteLength(text.slice(start - 1)) <= maxBytes) start--;
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start++;
  return text.slice(start);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function buildMarker(omittedBytes: number, totalLines: number, fullRef?: BlobRef): string {
  const ref = fullRef === undefined ? '' : `完整内容: ${formatBlobRef(fullRef)}，`;
  return (
    `\n[... 已省略约 ${omittedBytes.toLocaleString('en-US')} 字节 ` +
    `/ 原文共 ${totalLines.toLocaleString('en-US')} 行。` +
    `${ref}可用 result.expand 工具按行范围读取 ...]\n`
  );
}

function insertMarker(kept: string, marker: string, strategy: string): string {
  if (strategy === 'head') return kept + marker;
  if (strategy === 'tail') return marker + kept;
  // middle：标记落在两段之间，让模型清楚看到"中间被挖掉了"
  const mid = splitPoint(kept);
  return kept.slice(0, mid) + marker + kept.slice(mid);
}

/** 从中点向后找最近的换行，避免把标记塞进一行的中间 */
function splitPoint(text: string): number {
  const mid = Math.floor(text.length / 2);
  const nl = text.indexOf('\n', mid);
  if (nl !== -1) return nl;
  return isHighSurrogate(text.charCodeAt(mid - 1)) ? mid - 1 : mid;
}
