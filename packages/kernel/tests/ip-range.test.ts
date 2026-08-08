import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedIp, normalizeHostTarget } from '@xm/kernel';

/**
 * `isPrivateOrReservedIp` 的输入契约是"已经过 `normalizeHostTarget` 归一的主机名，
 * 不带端口"。这里统一走 `host()` 帮手函数，模拟真实调用方（网关）的用法：
 * 先归一一条完整 URL，再切掉端口，才喂给判定函数——不直接手写裸 IP 字符串，
 * 避免测试自己的输入形态就和生产代码的输入契约脱节。
 */
const host = (url: string): string => {
  const r = normalizeHostTarget(url);
  if (!r.ok) throw new Error(`本该归一成功：${url} —— ${r.reason}`);
  return stripPort(r.value);
};

// IPv4 与 IPv6 的端口切法不同（IPv6 是 `[::1]:8080`），归一后的值本身已经区分好了
function stripPort(normalized: string): string {
  if (normalized.startsWith('[')) {
    const close = normalized.indexOf(']');
    return normalized.slice(0, close + 1);
  }
  const idx = normalized.lastIndexOf(':');
  return idx === -1 ? normalized : normalized.slice(0, idx);
}

describe('isPrivateOrReservedIp —— IPv4 网段边界', () => {
  const cases: readonly [string, boolean][] = [
    ['http://0.0.0.0/', true],
    ['http://0.255.255.255/', true],
    ['http://1.0.0.0/', false], // 0.0.0.0/8 之外

    ['http://9.255.255.255/', false],
    ['http://10.0.0.0/', true],
    ['http://10.255.255.255/', true],
    ['http://11.0.0.0/', false],

    ['http://100.63.255.255/', false],
    ['http://100.64.0.0/', true],
    ['http://100.127.255.255/', true],
    ['http://100.128.0.0/', false],

    ['http://126.255.255.255/', false],
    ['http://127.0.0.0/', true],
    ['http://127.0.0.1/', true],
    ['http://127.255.255.255/', true],
    ['http://128.0.0.0/', false],

    ['http://169.253.255.255/', false],
    ['http://169.254.0.0/', true],
    ['http://169.254.169.254/', true], // 云元数据地址（AWS/GCP/Azure 通用）
    ['http://169.254.170.2/', true], // AWS ECS 任务凭据端点
    ['http://169.255.0.0/', false],

    ['http://172.15.255.255/', false],
    ['http://172.16.0.0/', true],
    ['http://172.31.255.255/', true],
    ['http://172.32.0.0/', false],

    ['http://192.0.0.0/', true],
    ['http://192.0.0.255/', true],
    ['http://192.0.1.0/', false],
    ['http://192.0.2.0/', true],
    ['http://192.0.2.255/', true],
    ['http://192.0.3.0/', false],

    ['http://192.167.255.255/', false],
    ['http://192.168.0.0/', true],
    ['http://192.168.255.255/', true],
    ['http://192.169.0.0/', false],

    ['http://198.17.255.255/', false],
    ['http://198.18.0.0/', true],
    ['http://198.19.255.255/', true],
    ['http://198.20.0.0/', false],

    ['http://223.255.255.255/', false],
    ['http://224.0.0.0/', true],
    ['http://239.255.255.255/', true],
    ['http://240.0.0.0/', true],
    ['http://255.255.255.255/', true],

    ['http://8.8.8.8/', false], // 一个普通公网地址，作为反例
    ['http://1.1.1.1/', false],
  ];

  for (const [url, expected] of cases) {
    it(`${url} → ${expected ? '保留/私网' : '公网'}`, () => {
      expect(isPrivateOrReservedIp(host(url))).toBe(expected);
    });
  }
});

describe('isPrivateOrReservedIp —— IPv6', () => {
  const cases: readonly [string, boolean][] = [
    ['http://[::1]/', true], // 回环
    ['http://[::]/', true], // 未指定地址
    ['http://[::2]/', false], // ::1 之外的"::x"不是回环

    ['http://[::ffff:127.0.0.1]/', true], // IPv4-mapped，内嵌回环
    ['http://[::ffff:8.8.8.8]/', false], // IPv4-mapped，内嵌公网地址

    ['http://[fc00::1]/', true], // ULA
    ['http://[fdff:ffff::1]/', true], // ULA 上边界附近
    ['http://[fe00::1]/', false], // ULA 之外（fc00::/7 只到 fdff）

    ['http://[fe80::1]/', true], // link-local
    ['http://[febf:ffff::1]/', true], // link-local 上边界（fe80::/10 到 febf）
    ['http://[fec0::1]/', false], // link-local 之外

    ['http://[ff02::1]/', true], // 组播
    ['http://[fd00:ec2::254]/', true], // 🔴 AWS IMDSv6，落在 fc00::/7 里，单独钉一条

    ['http://[2606:4700:4700::1111]/', false], // 公网地址（Cloudflare DNS），反例
  ];

  for (const [url, expected] of cases) {
    it(`${url} → ${expected ? '保留/私网' : '公网'}`, () => {
      expect(isPrivateOrReservedIp(host(url))).toBe(expected);
    });
  }
});

describe('isPrivateOrReservedIp —— 非 IP 字面量', () => {
  it('普通域名不落在任何网段判定里，返回 false（网关只会拿解析出的 IP 来问）', () => {
    expect(isPrivateOrReservedIp('example.com')).toBe(false);
    expect(isPrivateOrReservedIp('localhost')).toBe(false);
  });
});
