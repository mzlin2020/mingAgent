import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import type { ToolContext } from '@xm/kernel';
import { webFetchTool } from '@xm/tools-core';

/**
 * `web.fetch` 的单测走**真实的本机回环连接**，不 mock undici 内部——这个工具的
 * 安全性质恰恰系于"真的建立了一次 TCP 连接，且连的是网关钉住的那个地址"，
 * mock 掉 undici 会把这条链路的验证一起 mock 掉。回环连接不出这台机器，
 * 与"测试不发真实网络请求"的纪律并不冲突。
 *
 * 🔴 结构性验证的核心手法：把 URL 的主机名设成 `.invalid`（RFC 2606 保留，
 * 保证在任何环境下都不会被真实 DNS 解析出结果），同时在 `pinnedHosts` 里把它
 * 映射到本机测试服务器的地址。如果请求真的打到了测试服务器，就证明这个工具
 * 全程没有自己发起过一次 DNS 解析——它唯一的依据就是 `pinnedHosts`。
 */

let server: Server;
let port: number;
let lastRequest: { method: string; url: string; headers: Record<string, string | undefined>; body: string } | undefined;
let nextResponse: { status: number; headers: Record<string, string>; body: string } = {
  status: 200,
  headers: { 'content-type': 'text/plain' },
  body: 'hello',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(nextResponse.status, nextResponse.headers);
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
        resolve();
      });
  });
});

const HOSTNAME = 'web-fetch-test.invalid'; // RFC 2606：这个 TLD 保证解析不出任何真实地址

const ctx = (pinned?: { address: string; family: 4 | 6 }): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: '/',
  executor: 'local',
  ...(pinned === undefined
    ? {}
    : { pinnedHosts: new Map([[HOSTNAME, pinned]]) }),
});

const url = (path = '/'): string => `http://${HOSTNAME}:${String(port)}${path}`;

const run = async (
  input: Parameters<ReturnType<typeof webFetchTool>['execute']>[0],
  context: ToolContext,
): Promise<string> => {
  const tool = webFetchTool();
  const parsed = tool.parseInput(input);
  let result = '';
  for await (const progress of tool.execute(parsed, context)) {
    if (progress.kind === 'result') {
      const block = progress.forModel[0];
      result = block?.type === 'text' ? block.text : '';
    }
  }
  return result;
};

describe('🔴 全程不自己发起 DNS 解析 —— 只信 pinnedHosts', () => {
  it('主机名解析不出任何真实地址，但请求依然打到了 pinnedHosts 指向的本机服务器', async () => {
    nextResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: '来自回环服务器' };
    const text = await run({ url: url() }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toContain('来自回环服务器');
    expect(lastRequest?.method).toBe('GET');
  });

  it('pinnedHosts 里找不到对应主机名 → 拒绝执行，且不发起任何连接', async () => {
    await expect(run({ url: url() }, ctx())).rejects.toThrow(/pinnedHosts|内部错误/);
  });
});

describe('请求侧', () => {
  it('方法、请求头、请求体原样透传', async () => {
    nextResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
    await run(
      { url: url('/echo'), method: 'POST', headers: { 'x-trace': 'abc' }, body: 'payload' },
      ctx({ address: '127.0.0.1', family: 4 }),
    );
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.headers['x-trace']).toBe('abc');
    expect(lastRequest?.body).toBe('payload');
  });

  it('Host 头由底层控制，调用方传的会被剔除', async () => {
    nextResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
    await run(
      { url: url(), headers: { Host: 'attacker.example' } },
      ctx({ address: '127.0.0.1', family: 4 }),
    );
    // 真正连接的是回环服务器，Host 头必然是它自己的地址，不是调用方想塞的值
    expect(lastRequest?.headers.host).not.toBe('attacker.example');
  });

  it('请求体超过上限直接拒绝，不发起连接', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const before = lastRequest;
    const text = await run({ url: url(), method: 'POST', body: huge }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toMatch(/超过单次上限/);
    expect(lastRequest).toBe(before); // 没有发起新的请求
  });
});

describe('响应侧', () => {
  it('3xx 不跟随，原样报告状态与 Location', async () => {
    nextResponse = { status: 302, headers: { location: 'http://elsewhere.invalid/' }, body: '' };
    const text = await run({ url: url() }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toContain('302');
    expect(text).toContain('elsewhere.invalid');
  });

  it('非文本 Content-Type 不读取正文，只说明情况', async () => {
    nextResponse = { status: 200, headers: { 'content-type': 'image/png' }, body: '\x89PNG...' };
    const text = await run({ url: url() }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toMatch(/不支持二进制响应体/);
    expect(text).not.toContain('PNG');
  });

  it('响应体超过上限截断，并说明已截断', async () => {
    nextResponse = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'y'.repeat(600 * 1024),
    };
    const text = await run({ url: url() }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toMatch(/已读到.*KB 上限/);
  });

  it('application/json 也算文本，正文原样返回', async () => {
    nextResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' };
    const text = await run({ url: url() }, ctx({ address: '127.0.0.1', family: 4 }));
    expect(text).toContain('{"a":1}');
  });
});
