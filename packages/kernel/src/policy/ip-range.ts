/**
 * IP 级 SSRF 判定 —— `host-target.ts` 明确留给"能力网关"的那一半（M1-d）。
 *
 * ── 分工边界 ──
 *
 * `normalizeHostTarget` 只做**词法**归一（大小写、端口、userinfo……），它自己写明了
 * "真正的 SSRF 防御是在发请求的那一层按解析出的 IP 判定"。这个文件就是那一层的判定逻辑：
 * 纯函数、零 I/O——**谁去 DNS 解析、解析出的地址是不是这里的入参，都不是这个文件管的事**，
 * 它只回答一个问题："这个已经是字面量形式的地址，是不是内网/保留段"。
 *
 * 调用方（`packages/tools-core/src/gateway.ts`）负责：解析域名拿到 IP → 把 IP 拼成一个
 * 合法的 URL 当成第二条 claim 送去判权 → `evaluate()` 在 `matches()` 里调用这个文件。
 *
 * ── 入参契约 ──
 *
 * 入参必须是**已经过 `normalizeHostTarget` 规范化之后**的值（可能带 `:port`，这里自己
 * 先切掉）。这样这个模块不用重新处理编码歧义（十进制/八进制 IP、userinfo、大小写……）——
 * 那些 `host-target.ts` 已经解决过了，职责单一，容易穷举测试。
 *
 * ── 覆盖的网段 ──
 *
 * IPv4：`0.0.0.0/8`（本网络）、`10.0.0.0/8` `172.16.0.0/12` `192.168.0.0/16`（RFC 1918
 * 私网）、`100.64.0.0/10`（RFC 6598 CGNAT）、`127.0.0.0/8`（回环）、`169.254.0.0/16`
 * （RFC 3927 link-local，**云元数据地址 `169.254.169.254`/`169.254.170.2` 落在这一段**）、
 * `192.0.0.0/24`（IETF 保留）、`192.0.2.0/24`（TEST-NET-1）、`198.18.0.0/15`（基准测试网段）、
 * `224.0.0.0/4`（组播）、`240.0.0.0/4`（保留 + 广播地址 `255.255.255.255`）。
 *
 * IPv6：`::1`/`::`（回环/未指定）、`::ffff:0:0/96`（IPv4-mapped，递归判内嵌的 v4 地址）、
 * `fc00::/7`（ULA）、`fe80::/10`（link-local）、`ff00::/8`（组播）。
 * AWS 的 IMDSv6 地址 `fd00:ec2::254` 落在 `fc00::/7` 里，不需要单独一条规则，
 * 但值得单独写一条测试用例——它是这份清单真正要挡住的东西之一。
 */

/** 每一段用 `[起始, 结束]` 闭区间描述——CIDR 只在这里出现一次，判定是纯数值比较 */
function ipv4Range(base: string, prefixBits: number): { readonly start: number; readonly end: number } {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  const start = (ipv4ToInt(base) & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

function ipv4ToInt(dotted: string): number {
  const parts = dotted.split('.').map(Number);
  return (
    (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0
  );
}

const IPV4_RANGES: readonly { readonly start: number; readonly end: number }[] = [
  ipv4Range('0.0.0.0', 8), // RFC 1122 §3.2.1.3："this network"
  ipv4Range('10.0.0.0', 8), // RFC 1918 私网
  ipv4Range('100.64.0.0', 10), // RFC 6598 CGNAT
  ipv4Range('127.0.0.0', 8), // RFC 1122 回环
  ipv4Range('169.254.0.0', 16), // RFC 3927 link-local（含云元数据地址）
  ipv4Range('172.16.0.0', 12), // RFC 1918 私网
  ipv4Range('192.0.0.0', 24), // RFC 6890 IETF Protocol Assignments
  ipv4Range('192.0.2.0', 24), // RFC 5737 TEST-NET-1
  ipv4Range('192.168.0.0', 16), // RFC 1918 私网
  ipv4Range('198.18.0.0', 15), // RFC 2544 基准测试网段
  ipv4Range('224.0.0.0', 4), // RFC 5771 组播
  ipv4Range('240.0.0.0', 4), // 保留段，含 255.255.255.255 广播地址
];

function parseIpv4(host: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return undefined;
  if ([m[1], m[2], m[3], m[4]].some((s) => Number(s) > 255)) return undefined;
  return ipv4ToInt(host);
}

function isReservedIpv4(n: number): boolean {
  return IPV4_RANGES.some(({ start, end }) => n >= start && n <= end);
}

/**
 * 把 `normalizeHostTarget` 吐出的 **RFC 5952 紧凑形式**（`fe80::1` 这种，至多一个 `::`，
 * 全小写十六进制组，不含内嵌的点分四段——那个形态在归一时已经折进十六进制组了）
 * 展开回 8 个 16 位组。
 *
 * 这不是重新实现 `host-target.ts` 里 `normalizeIpv6` 那一整套解析——那个函数要扛住
 * 任意原始写法（大小写混杂、内嵌 v4、多种 `::` 位置、非法字符……），这里的入参已经是
 * 它算出来的、唯一确定的紧凑形式，只需要做归一的**逆运算**，形状简单得多，
 * 没有必要也不应该合并成一份——真正棘手、需要穷举测试的解析逻辑只应该有一份，
 * 留在 `host-target.ts`；这里只做"展开一个已知合法的紧凑串"这件小事。
 */
function expandCompactIpv6(text: string): readonly number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const parseSide = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0] ?? '');
    return groups?.length === 8 ? groups : undefined;
  }

  const left = parseSide(halves[0] ?? '');
  const right = parseSide(halves[1] ?? '');
  if (left === undefined || right === undefined) return undefined;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return undefined;
  return [...left, ...Array<number>(zeros).fill(0), ...right];
}

function isReservedIpv6(bracketedBody: string): boolean {
  const groups = expandCompactIpv6(bracketedBody);
  if (groups === undefined) return false; // 展开不了：不是这个函数的判定范围，交给别处失败关闭
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  // ::/128（未指定）与 ::1/128（回环）
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }

  // ::ffff:0:0/96（IPv4-mapped）—— 递归判内嵌的 v4 地址，不是单独一段规则
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = ((g6 << 16) | g7) >>> 0;
    return isReservedIpv4(v4);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA（含 AWS IMDSv6 的 fd00:ec2::254）
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播

  return false;
}

/**
 * 入参是已经过 `normalizeHostTarget` 规范化的主机（不带端口，调用方自己先切掉）。
 * 不是字面量 IP（普通域名）返回 `false`——域名本身不落在任何网段里，这里判不了，
 * 也不需要判：网关只会拿**解析出的 IP** 来问这个函数。
 */
export function isPrivateOrReservedIp(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return isReservedIpv6(host.slice(1, -1));
  }
  const v4 = parseIpv4(host);
  return v4 === undefined ? false : isReservedIpv4(v4);
}
