import type { TargetNormalization } from './target.js';

/**
 * 网络目的地的规范化 —— 安全边界上的**词法**归一（ADR-0020）。
 *
 * ── 为什么必须有这一层 ──
 *
 * 与路径完全同构的一个问题（ADR-0012 ①）：规则是字面量 glob，`target` 是运行时给的字符串，
 * 两边对不上，规则就是摆设。docs/09 G3 点名了这条：
 *
 *   规则写 `deny net.fetch *.evil.com`，而运行时可以传
 *     · `https://EVIL.com/`            大小写
 *     · `https://x.evil.com:443/`      默认端口
 *     · `https://evil.com./`           FQDN 尾点
 *     · `https://good.com@evil.com/`   userinfo（同时骗人和骗朴素规则）
 *     · `http://2130706433/`           十进制 IP
 *     · `http://ev%69l.com/`           百分号编码
 *     · `https://еvil.com/`            西里尔字母 е
 *
 *   ——七种写法，同一个目的地，全部绕过。
 *
 * ── 边界在哪 ──
 *
 * 只做**词法**归一。不做、也做不了的：DNS 解析、IDNA 转换、CNAME 跟随、
 * "这个域名今天指向哪个 IP"——那些要么需要网络，要么需要 Unicode 表，而内核零 I/O、
 * 零依赖。判不了的一律**失败关闭**，并在理由里说清该由谁去做（`@xm/platform` 与将来的
 * 能力网关有 `URL` 与 `punycode`）。这与 8.3 短文件名的分工完全一致（ADR-0018 决策三）。
 *
 * ⚠️ **归一之后的匹配仍然只是"目的地写法"层面的防线。** 真正的 SSRF 防御是在发请求的
 * 那一层按解析出的 IP 判定（内网段、link-local、重绑定）。这里能保证的是：
 * *同一个目的地的不同写法会得到同一个字符串*，仅此而已。ADR-0020 里把这条写成了限制。
 */

/** 必须带 scheme。理由见 `normalizeHostTarget` 里那段注释 */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** 主机名允许的字符。任何 `%`、`_`、空格、非 ASCII 都不在其中——这是一道**白名单** */
const HOST_CHARS = /^[a-zA-Z0-9.-]+$/;

/** 可能是某种进制的 IP 字面量的一段：纯数字，或 `0x` 开头的十六进制 */
const NUMERIC_LABEL = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' };

export function normalizeHostTarget(raw: string): TargetNormalization {
  if (raw === '') return { ok: false, reason: '网络目标为空' };
  if (raw.includes('\0')) return { ok: false, reason: '网络目标含空字节' };

  /*
   * **必须带 scheme，不接受裸主机名。**
   *
   * 不是洁癖：`evil.com:8080` 这个串，既可以读成"主机 evil.com 端口 8080"，
   * 也可以读成"scheme evil.com 路径 8080"。在安全边界上，一个有两种读法的输入
   * 只有一种正确处理方式——拒绝。
   *
   * 而且要求全 URL 顺带修好了另一件事：target 变成了**工具真正会去请求的那个东西**，
   * 而不是它对自己意图的一句概括。判定看到的和执行的是同一个值，这正是
   * turn.ts 里"先 parse 再判权"要解决的那类 TOCTOU。
   */
  const scheme = SCHEME.exec(raw);
  if (scheme === null) {
    return {
      ok: false,
      reason:
        `网络目标 "${raw}" 没有 scheme。请传工具真正会请求的完整 URL（http:// 或 https://）——` +
        `裸主机名里的 "a:b" 有两种读法，安全边界上不接受有歧义的输入。`,
    };
  }

  const proto = (scheme[1] ?? '').toLowerCase();
  if (proto !== 'http' && proto !== 'https') {
    /*
     * **只认 http(s)。这一条是本文件里最要紧的一条。**
     *
     * 放过 `file://` 意味着 `net.fetch file:///etc/passwd` 变成一条读文件的路径，
     * 而它绕开了全部 `fs.*` 规则——因为判定用的是 `net.fetch` 这个能力，
     * 路径类红线一条也匹配不上。`data:` / `blob:` 同理，它们根本没有目的地可判。
     */
    return {
      ok: false,
      reason:
        `网络目标的 scheme 是 "${proto}"，只支持 http / https。` +
        `其它 scheme（file / data / blob…）不是网络目的地，用它们发起 "net.fetch" ` +
        `等于绕开该资源本该受到的那一类规则。`,
    };
  }

  // authority = scheme 之后、第一个 / ? # 之前的那一段
  const rest = raw.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);

  /*
   * userinfo 丢掉。真实的主机是 `@` **之后**那个——
   * `https://good.com@evil.com/` 去的是 evil.com，而人眼和朴素的子串规则都会看成 good.com。
   * 取最后一个 `@`：userinfo 里出现未编码的 `@` 本就不合法，但按最后一个切，
   * 无论如何都落在真正的 host 上。
   */
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);

  if (authority === '') return { ok: false, reason: `网络目标 "${raw}" 里没有主机` };

  const split = splitHostPort(authority);
  if (!split.ok) return split;

  const host = split.host.startsWith('[')
    ? normalizeIpv6(split.host)
    : normalizeHostname(split.host);
  if (!host.ok) return host;

  const port = split.port;
  if (port !== undefined) {
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { ok: false, reason: `网络目标的端口 "${port}" 不合法` };
    }
  }
  // 默认端口归一：`https://x:443` 与 `https://x` 是同一个目的地
  const keepPort = port !== undefined && port !== DEFAULT_PORTS[proto];

  return { ok: true, value: keepPort ? `${host.value}:${port}` : host.value };
}

type Split = { ok: true; host: string; port: string | undefined } | { ok: false; reason: string };

function splitHostPort(authority: string): Split {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return { ok: false, reason: `IPv6 字面量 "${authority}" 缺少右方括号` };
    const tail = authority.slice(close + 1);
    if (tail !== '' && !tail.startsWith(':')) {
      return { ok: false, reason: `IPv6 字面量之后出现了无法解析的 "${tail}"` };
    }
    return { ok: true, host: authority.slice(0, close + 1), port: tail === '' ? undefined : tail.slice(1) };
  }

  const parts = authority.split(':');
  if (parts.length > 2) {
    // 不带方括号却有多个冒号：要么是漏写方括号的 IPv6，要么是别的什么。都判不了
    return { ok: false, reason: `网络目标 "${authority}" 含多个冒号；IPv6 字面量必须写成 [..] 形式` };
  }
  return { ok: true, host: parts[0] ?? '', port: parts[1] };
}

function normalizeHostname(rawHost: string): TargetNormalization {
  if (!HOST_CHARS.test(rawHost)) {
    /*
     * 白名单之外的一切。两类值得单独说：
     *
     *   · `%`  —— `ev%69l.com` 解码后是 `evil.com`。内核不做百分号解码：解码要处理
     *             双重编码、非法序列、解码后再出现分隔符，每一条都是历史上真实的绕过。
     *   · 非 ASCII —— `еvil.com`（西里尔 е）与 `evil.com` 在屏幕上一模一样，
     *             要判等必须做 IDNA/punycode，那需要 Unicode 表，内核没有。
     *             与 8.3 短名同样的分工：**有能力做的那一层先转好再送进来**。
     */
    return {
      ok: false,
      reason:
        `主机名 "${rawHost}" 含有不允许的字符。只接受 ASCII 字母、数字、"." 与 "-"：` +
        `百分号编码与非 ASCII（IDN）需要解码/IDNA 表才能判等，内核零依赖做不了——` +
        `请调用方先解码并转成 punycode 再送进来。`,
    };
  }

  // FQDN 尾点：`evil.com.` 与 `evil.com` 是同一个域
  const host = (rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost).toLowerCase();

  if (host === '') return { ok: false, reason: '主机名为空' };
  if (host.includes('..')) return { ok: false, reason: `主机名 "${rawHost}" 含空标签` };
  if (host.startsWith('.')) return { ok: false, reason: `主机名 "${rawHost}" 以 "." 开头` };

  const labels = host.split('.');

  /*
   * ── 数字形态的 IP 字面量 ──
   *
   * `http://2130706433/`、`http://0177.0.0.1/`、`http://0x7f.1/` 全都会被解析成
   * 127.0.0.1，而按点分四段写的规则一个都匹配不上。内核不做进制换算（那是在安全边界上
   * 自己实现一遍 inet_aton，历史证明这件事很难做对），改成**判形**：
   *
   *   只要每一段看起来都可能是数字/十六进制，它就必须**恰好是规范的点分四段**，否则拒绝。
   *
   * 这样 `1.com`（有非数字段）走普通主机名，`127.0.0.1` 通过，
   * 而所有非规范写法一律失败关闭。
   */
  if (labels.every((l) => NUMERIC_LABEL.test(l))) {
    const canonical =
      labels.length === 4 &&
      labels.every((l) => /^(?:0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255);
    if (!canonical) {
      return {
        ok: false,
        reason:
          `主机名 "${rawHost}" 看起来是数字形式的 IP，但不是规范的点分四段。` +
          `十进制/八进制/十六进制写法都会被解析成同一个地址，而按点分四段写的规则匹配不上——` +
          `请调用方先转成规范写法。`,
      };
    }
  }

  for (const l of labels) {
    if (l === '') return { ok: false, reason: `主机名 "${rawHost}" 含空标签` };
    if (l.startsWith('-') || l.endsWith('-')) {
      return { ok: false, reason: `主机名 "${rawHost}" 的标签 "${l}" 以 "-" 开头或结尾` };
    }
  }

  return { ok: true, value: host };
}

/**
 * IPv6 字面量归一到 RFC 5952 形式。
 *
 * 为什么值得为它写这一段：`[::1]`、`[0:0:0:0:0:0:0:1]`、`[::0001]`、`[::FFFF:127.0.0.1]`
 * 是同一个地址的四种写法。**这正是 8.3 短文件名那一类问题**——罕见、看起来像兼容性细节、
 * 因为罕见所以没人测，而"同一个目标两种写法两种判定结果"从来不因为罕见就不是绕过
 * （ADR-0018 就是这么来的）。
 */
function normalizeIpv6(bracketed: string): TargetNormalization {
  const body = bracketed.slice(1, -1);
  const fail = (why: string): TargetNormalization => ({
    ok: false,
    reason: `IPv6 字面量 "${bracketed}" ${why}`,
  });

  if (body.includes('%')) return fail('含 zone id，内核无法判定它指向哪张网卡');

  // 末尾的点分四段（`::ffff:127.0.0.1`）先折成两个 16 位组
  let head = body;
  let tail4: number[] = [];
  const lastColon = body.lastIndexOf(':');
  const maybeV4 = body.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const parts = maybeV4.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)) {
      return fail('末尾的 IPv4 段不是规范的点分四段');
    }
    const [a, b, c, d] = parts.map(Number) as [number, number, number, number];
    tail4 = [(a << 8) | b, (c << 8) | d];
    /*
     * `head` 是 v4 段之前的那部分。末尾那个 `:` 要去掉，**但 `::` 必须完整保留**——
     * 它是零压缩标记，不是分隔符。`[::1.2.3.4]` 的 head 是 `::`，砍成 `:` 之后
     * 整条就解析不出来了（这行第一版把两个分支写成了同一件事，`[::ffff:127.0.0.1]`
     * 恰好还对，`[::1.2.3.4]` 就炸——用例里现在两种都验）。
     */
    head = body.slice(0, lastColon + 1);
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }

  const double = head.indexOf('::');
  if (head.includes('::', double + 1)) return fail('含多个 "::"');

  const parseGroups = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (double === -1) {
    const g = parseGroups(head);
    if (g === undefined) return fail('含非法的十六进制组');
    groups = [...g, ...tail4];
    if (groups.length !== 8) return fail('不是 8 组');
  } else {
    const left = parseGroups(head.slice(0, double));
    const right = parseGroups(head.slice(double + 2));
    if (left === undefined || right === undefined) return fail('含非法的十六进制组');
    const rest = [...right, ...tail4];
    const zeros = 8 - left.length - rest.length;
    if (zeros < 1) return fail('"::" 没有可压缩的零组');
    groups = [...left, ...Array<number>(zeros).fill(0), ...rest];
  }

  // RFC 5952：小写、去前导零、压缩**最长**的一段零（并列取最左），长度 1 的零段不压缩
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j - 1;
  }

  const hex = groups.map((g) => g.toString(16));
  let text: string;
  if (bestLen < 2) {
    text = hex.join(':');
  } else {
    text = `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
  }

  return { ok: true, value: `[${text}]` };
}
