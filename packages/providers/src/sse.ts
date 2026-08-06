/**
 * SSE（text/event-stream）帧读取器。**一份实现喂两家。**
 *
 * 写在共用文件里不是为了省几十行，是为了让"分帧"这件事只有一个答案。
 * Anthropic 与 OpenAI 的 SSE 分帧规则完全相同，差异全在 `data` 里的 JSON——
 * 如果两个适配器各自解析一遍，两份实现在 `\r\n`、多行 data、注释行这些边角上
 * 一定会慢慢分叉，而分叉的表现是"某一家偶尔丢一个 chunk"。
 *
 * ── 未知字段与未知事件类型一律忽略并继续 ──
 *
 * 与 `EventEnvelope` 用 loose 的理由是同一条：上游加字段是版本漂移的**正常形态**，
 * 不是错误。一个 `throw new Error('未知的 SSE 事件')` 会让某天上游加一种新事件时，
 * 用户看到的是整个会话崩掉。
 */

export interface SseFrame {
  /** `event:` 字段。缺省时按 SSE 规范是 `"message"` */
  readonly event: string;
  /** `data:` 字段，多行已按规范用 `\n` 连接 */
  readonly data: string;
}

/**
 * 把字节流切成帧。
 *
 * **取消由调用方通过 `reader.cancel()` 生效，不靠在这里轮询 `aborted`。**
 * 轮询的语义是"等下一个 chunk 到达时才发现该停了"，而模型完全可能正卡在一段
 * 长思考里——那时下一个 chunk 是三十秒之后。停止按钮的 200ms 承诺死在这种地方。
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // stream: true —— 一个多字节字符可能横跨两个 chunk，不这样会解出替换字符
      buffer += decoder.decode(value, { stream: true });

      let boundary = findFrameBoundary(buffer);
      while (boundary !== undefined) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseFrame(raw);
        if (frame !== undefined) yield frame;
        boundary = findFrameBoundary(buffer);
      }
    }

    // 流结束时缓冲里还剩东西：上游没有以空行收尾。按规范这一段应当被丢弃，
    // 但真实世界里它通常是一个完整的最后帧，丢掉等于莫名少一个 chunk。
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    // 提前 return / throw 都会走到这里。不 cancel 会让底层连接留着不放。
    await reader.cancel().catch(() => undefined);
  }
}

/** 帧分隔是一个空行，而空行有四种写法 */
function findFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined;
  for (const sep of ['\r\n\r\n', '\n\n', '\r\r']) {
    const index = buffer.indexOf(sep);
    if (index === -1) continue;
    if (best === undefined || index < best.index) best = { index, length: sep.length };
  }
  return best;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = 'message';
  const data: string[] = [];
  let sawData = false;

  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === '') continue;
    // `:` 开头是注释（很多服务端拿它当心跳），整行丢弃
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // 规范：冒号后若紧跟一个空格，去掉这一个空格（且只去一个）
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
      sawData = true;
    }
    // id / retry / 未知字段：忽略。我们不做断线续读，`id` 对我们没有意义
  }

  if (!sawData) return undefined;
  return { event, data: data.join('\n') };
}
