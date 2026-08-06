import { describe, expect, it } from 'vitest';
import { readSseFrames } from '@xm/providers';
import { hangingStream, streamOf } from './helpers/stream.js';

/**
 * SSE 分帧。
 *
 * 这些用例看着琐碎，但它们守的是一条很实际的性质：**同一段字节，无论网络怎么切片，
 * 解出来的帧必须一模一样**。分片边界是这类解析器唯一的真实风险来源——
 * 生产上不会有人手动构造 `\r\r`，但 TCP 一定会在某个字符中间断开。
 */

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = [];
  for await (const f of readSseFrames(stream)) out.push({ event: f.event, data: f.data });
  return out;
}

describe('SSE 分帧', () => {
  it('解出 event 与 data', async () => {
    const frames = await collect(streamOf('event: ping\ndata: {"a":1}\n\n'));
    expect(frames).toEqual([{ event: 'ping', data: '{"a":1}' }]);
  });

  it('没有 event 字段时按规范默认为 message', async () => {
    expect(await collect(streamOf('data: hi\n\n'))).toEqual([{ event: 'message', data: 'hi' }]);
  });

  it('多行 data 按 \\n 连接', async () => {
    const frames = await collect(streamOf('data: a\ndata: b\ndata: c\n\n'));
    expect(frames[0]?.data).toBe('a\nb\nc');
  });

  it('冒号后只去掉一个空格 —— 第二个空格是数据的一部分', async () => {
    expect((await collect(streamOf('data:  x\n\n')))[0]?.data).toBe(' x');
  });

  it('注释行（`:` 开头的心跳）被丢弃，且不产生空帧', async () => {
    const frames = await collect(streamOf(': keep-alive\n\ndata: real\n\n'));
    expect(frames).toEqual([{ event: 'message', data: 'real' }]);
  });

  it('CRLF 与 LF 混用解出同样的结果', async () => {
    const crlf = await collect(streamOf('event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n'));
    const lf = await collect(streamOf('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'));
    expect(crlf).toEqual(lf);
  });

  it('🔴 逐字节喂进去，解出的帧与一次性喂完全一致', async () => {
    const raw = 'event: message_start\ndata: {"x":1}\n\nevent: ping\ndata: {}\n\ndata: 中文也要对\n\n';
    const whole = await collect(streamOf(raw));
    const byByte = await collect(streamOf(raw, 1));
    expect(byByte).toEqual(whole);
    // 多字节字符横跨分片时不会解出替换字符——decode({stream:true}) 就是为这个
    expect(byByte.at(-1)?.data).toBe('中文也要对');
  });

  it('流以非空行结尾时，最后那一帧不丢', async () => {
    // 规范上应当丢弃，但真实服务端偶尔就这么收尾，丢掉等于莫名少一个 chunk
    expect(await collect(streamOf('data: tail\n'))).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('未知字段（id / retry / 自定义）被忽略，不影响这一帧', async () => {
    const frames = await collect(streamOf('id: 7\nretry: 100\nx-vendor: y\ndata: ok\n\n'));
    expect(frames).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('🔴 提前 break 会 cancel 底层流 —— 不 cancel 就是一条挂着不放的连接', async () => {
    const { stream, cancelled } = hangingStream('data: first\n\n');
    for await (const f of readSseFrames(stream)) {
      expect(f.data).toBe('first');
      break;
    }
    expect(cancelled()).toBe(true);
  });
});
