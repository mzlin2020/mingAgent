import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const WEB_FETCH = 'web.fetch';

/**
 * 抓一个 http(s) 地址（M1-d，IP 级 SSRF 判定的第一个真实调用点）。
 *
 * ── 为什么用 undici，不用 Node 全局 fetch ──
 *
 * 全局 `fetch` 底层就是 undici，但全局作用域不暴露 `Agent`/`Dispatcher`，拿不到
 * `connect.lookup` 这个钩子——而这个钩子是"钉住网关已经解析、已经判过权的那个
 * 地址，不让 undici 自己重新解析一次"的唯一入口。不接管它，这个工具在判权时看到
 * 的 IP 和真正建连时用的 IP 就可能是两个东西——一次时间窗口极短的 DNS rebinding
 * 就能让判定形同虚设。见 `ToolContext.pinnedHosts` 与 `gateway.ts` 的 `resolveHost`。
 *
 * ── 为什么不自动跟随重定向 ──
 *
 * 自动跟随会让攻击者用一个公网地址 302 到 `http://169.254.169.254/`——重定向目标
 * 从未经过 gateway→policy→DNS pin 这条完整链路，整套判定被绕开。这里把 3xx 原样
 * 说明给模型，逼它对新 URL 重新调用一次 `web.fetch`，保证每一跳都被判权。
 *
 * ── 为什么只处理文本响应 ──
 *
 * 二进制响应体（图片、压缩包）塞进模型上下文既无意义又浪费预算，处理它需要
 * `BlobStore` 参与（`ToolContext` 目前不含它）——留给多模态那一段一并做，
 * 这里先按 `fs-read.ts` 对二进制文件的同一个哲学：明确说明，不硬塞。
 */
const Input = z.strictObject({
  url: z.string().min(1).max(8192).describe('要请求的完整 URL，必须是 http:// 或 https://'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
    .optional()
    .describe('HTTP 方法，默认 GET'),
  headers: z.record(z.string(), z.string()).optional().describe('额外请求头'),
  body: z.string().optional().describe('纯文本请求体（不支持二进制上传）'),
});

/**
 * 规范输出值（ADR-0071）。
 *
 * `kind: 'redirect'` 单列一档是有意的：这个工具**不跟随重定向**，而 3xx 在散文里
 * 只是一句话。程序如果按"status 是不是 200"来判断，会把一次没跟随的跳转当成失败；
 * 按 `kind` 判断则一眼看出"要不要对 `location` 再调一次"——那正是这里希望它做的事。
 *
 * `body` 只在 `kind: 'ok'` 时非空：3xx 与非文本响应都主动 `cancel()` 了响应体，
 * 正文根本没有读进来。
 */
const Output = z.strictObject({
  url: z.string(),
  method: z.string(),
  kind: z.enum(['ok', 'redirect', 'non_text', 'request_failed', 'rejected']),
  status: z.number().int().optional(),
  statusText: z.string().optional(),
  contentType: z.string().optional(),
  /** `kind: 'redirect'` 时的 Location；服务器没给就缺席 */
  location: z.string().optional(),
  body: z.string(),
  /** 正文读到 512 KB 上限就停了，`body` 不完整 */
  truncated: z.boolean(),
  /** 请求根本没发出去或发失败时的说明 */
  message: z.string().optional(),
});

/** 请求体大小上限 */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** 响应体按流读、读满即停的上限——代价与结果大小同阶，不先囤积整份响应体再截断 */
const MAX_RESPONSE_BYTES = 512 * 1024;
/** 默认超时。入参不开放自定义——不能把它当成挂起攻击的旋钮 */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** 底层建连用的 header，工具自己控制，不接受调用方覆盖 */
const CONTROLLED_HEADERS = new Set(['host', 'content-length']);

const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i;

export const webFetchTool = (): RegisteredTool =>
  defineTool({
    name: WEB_FETCH,
    group: 'web',
    description:
      '发起一个 HTTP(S) 请求并返回文本响应。不跟随重定向（3xx 会原样返回状态与 Location，' +
      '需要跟随请重新调用一次）；不支持二进制响应体。',
    inputSchema: Input,
    risk: 'medium',
    capabilities: ['net.fetch'],
    concurrency: 'parallel',
    hostInputs: ['url'],
    outputSchema: Output,

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const base = { url: input.url, method: input.method ?? 'GET', body: '', truncated: false };
      if (input.body !== undefined && Buffer.byteLength(input.body, 'utf8') > MAX_REQUEST_BYTES) {
        const message = `拒绝发送：请求体超过单次上限 ${String(MAX_REQUEST_BYTES)} 字节。`;
        yield text(message, { ...base, kind: 'rejected', message });
        return;
      }

      const hostname = extractHostname(input.url);
      const pinned = hostname === undefined ? undefined : ctx.pinnedHosts?.get(hostname);
      if (pinned === undefined) {
        /*
         * 理论上走不到这——网关的 host 分支会在判权前解析并写入 `pinnedHosts`，
         * `evaluate()` 判定通过之后 `turn.ts` 才会调用到这里。找不到，说明网关与
         * 工具之间的约定被破坏了，这是一个内部错误，不是可以退化处理的用户输入问题：
         * 绝不能因为找不到就自己发起一次 DNS 解析——那正是要堵死的 rebinding 窗口。
         */
        throw new Error(
          `内部错误：找不到 "${hostname ?? input.url}" 对应的已解析地址（pinnedHosts）。` +
            `拒绝执行——本工具不会为了"凑合跑起来"而自己发起一次 DNS 解析。`,
        );
      }

      const headers = sanitizeHeaders(input.headers);
      const dispatcher = new Agent({
        connect: { lookup: pinnedLookup(pinned) as never },
      });

      const controller = new AbortController();
      const onAbort = (): void => {
        controller.abort();
      };
      ctx.signal.addEventListener('abort', onAbort);
      const timeout = setTimeout(() => {
        controller.abort();
      }, clampTimeout(undefined));

      /*
       * ⚠️ `dispatcher.close()` 必须等到响应体被读完（或主动取消）之后才调用。
       * `fetch()` 的 promise 一拿到响应头就 resolve，这时请求在 undici 内部仍然
       * "在途"——若在这里就关闭 dispatcher，`close()` 要等这个在途请求收尾才 resolve，
       * 而收尾恰恰要等下面的 `readCapped`/`cancel()` 把响应体处理完，两者互相等待、
       * 死锁。所以整个响应体处理流程都包在同一个 try/finally 里，`close()` 放在最后。
       */
      try {
        let response: Awaited<ReturnType<typeof undiciFetch>>;
        try {
          response = await undiciFetch(input.url, {
            method: input.method ?? 'GET',
            headers,
            ...(input.body === undefined ? {} : { body: input.body }),
            redirect: 'manual',
            dispatcher,
            signal: controller.signal,
          });
        } catch (e) {
          const message = `请求失败：${e instanceof Error ? e.message : String(e)}`;
          yield text(message, { ...base, kind: 'request_failed', message });
          return;
        }

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          yield text(
            `${String(response.status)} 重定向到 ${location ?? '（未提供 Location）'}。` +
              `本工具不自动跟随——每一跳都必须重新判权。如果确实要跟随，请对新地址再调用一次 web.fetch。`,
            {
              ...base,
              kind: 'redirect',
              status: response.status,
              statusText: response.statusText,
              ...(location === null ? {} : { location }),
            },
          );
          return;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!TEXT_CONTENT_TYPE.test(contentType)) {
          await response.body?.cancel();
          yield text(
            `响应不是文本内容（Content-Type: ${contentType || '（未提供）'}），` +
              `本工具当前不支持二进制响应体，没有读取正文。`,
            {
              ...base,
              kind: 'non_text',
              status: response.status,
              statusText: response.statusText,
              contentType,
            },
          );
          return;
        }

        const body = await readCapped(response.body, MAX_RESPONSE_BYTES);
        const note = body.truncated
          ? `\n[... 已读到 ${String(MAX_RESPONSE_BYTES / 1024)} KB 上限，响应可能不完整 ...]`
          : '';
        yield text(`${String(response.status)} ${response.statusText}\n\n${body.text}${note}`, {
          ...base,
          kind: 'ok',
          status: response.status,
          statusText: response.statusText,
          contentType,
          body: body.text,
          truncated: body.truncated,
        });
      } finally {
        clearTimeout(timeout);
        ctx.signal.removeEventListener('abort', onAbort);
        await dispatcher.close();
      }
    },
  });

/** 从一个已经能通过 `normalizeHostTarget` 的 URL 里取出裸主机名（不含端口、不含方括号） */
function extractHostname(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

/** 剔除调用方不该控制的请求头，其余原样透传 */
function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CONTROLLED_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** 入参不开放自定义超时——这里只是把默认值圈起来，留一个后续可以调整默认值的地方 */
function clampTimeout(overrideMs: number | undefined): number {
  const ms = overrideMs ?? DEFAULT_TIMEOUT_MS;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

/**
 * 把 `connect.lookup` 钩子替换成"忽略参数、直接回调网关钉住的地址"——
 * 从判权那一刻到真正建立 TCP 连接之间，不存在第二次域名解析。
 *
 * Node 的 `net.connect`（Happy Eyeballs / `autoSelectFamily`，Node 18.13+ 起默认开启）
 * 会带 `{ all: true }` 调用 `lookup`，此时期望回调的是**地址数组**而不是单个地址——
 * 两种形态 `LookupFunction` 的类型签名都允许，这里按 `options.all` 分流，
 * 不判断的话在真实调用中会被 `net` 内部当成"没有任何地址"直接报错。
 */
type LookupResult = string | readonly { readonly address: string; readonly family: 4 | 6 }[];
type LookupCallback = (error: Error | null, result: LookupResult, family?: 4 | 6) => void;

function pinnedLookup(pinned: { readonly address: string; readonly family: 4 | 6 }) {
  return (_hostname: string, options: { readonly all?: boolean }, callback: LookupCallback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: '', truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

const text = (s: string, output: z.infer<typeof Output>): ToolProgress => ({
  kind: 'result',
  forModel: [{ type: 'text', text: s }],
  output,
});
