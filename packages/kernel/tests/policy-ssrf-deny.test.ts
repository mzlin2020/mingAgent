import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { builtinRules, evaluate } from '@xm/kernel';

/**
 * 端到端验证 `def.no-fetch-private-network`（M1-d，IP 级 SSRF 判定）。
 *
 * 这里直接把 target 设成"解析出的 IP 拼成的 URL"，模拟网关产出的第二条 claim
 * （`packages/tools-core/src/gateway.ts` 的 host 分支）——策略引擎本身不知道、
 * 也不需要知道这个 target 是从哪个域名解析来的，它只按已经归一的字符串判。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

const req = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'medium',
  reason: '测试',
  trustLevel: 'model',
});

type EvalInput = Parameters<typeof evaluate>[0];
const judge = (
  input: Omit<EvalInput, 'layers'> & { layers: EvalInput['layers'] },
): ReturnType<typeof evaluate> => evaluate(input);

describe('🔴 M1-d DoD：web.fetch 解析到保留网段一律 deny', () => {
  const layers = [{ id: 'builtin' as const, rules: builtinRules(ENV) }];

  it.each([
    'http://169.254.169.254/', // 云元数据端点（DoD 原文点名）
    'http://169.254.170.2/', // AWS ECS 任务凭据端点
    'http://127.0.0.1:8080/', // 回环
    'http://10.0.0.5/', // RFC 1918 私网
    'http://192.168.1.1/', // RFC 1918 私网
    'http://[::1]/', // IPv6 回环
    'http://[fd00:ec2::254]/', // AWS IMDSv6
  ])('%s → deny（def.no-fetch-private-network）', (target) => {
    const v = judge({ request: req('net.fetch', target), tier: 'balanced', layers });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('def.no-fetch-private-network');
  });

  it('公网地址不受影响，走默认 ask —— 防线不能宽到把一切都拦下', () => {
    const v = judge({ request: req('net.fetch', 'https://example.com/'), tier: 'balanced', layers });
    expect(v.effect).toBe('ask');
    expect(v.ruleId).toBe('def.net-fetch');
  });

  it('YOLO 档也拦不过 —— 它是普通 deny，YOLO 只跳过 ask，不跳过任何 deny（docs/09 C5）', () => {
    const v = judge({
      request: req('net.fetch', 'http://169.254.169.254/'),
      tier: 'yolo',
      layers,
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('def.no-fetch-private-network');
  });

  it('用户在自己的配置里对解析出的具体地址写一条 allow 即可放开（分层覆盖，ADR-0023）', () => {
    const withUserAllow = [
      ...layers,
      {
        id: 'user' as const,
        rules: [
          {
            id: 'user.allow-localhost',
            effect: 'allow' as const,
            capability: 'net.fetch' as const,
            match: { target: '127.0.0.1*' },
            reason: '本机开发服务器',
            immutable: false,
          },
        ],
      },
    ];
    const v = judge({
      request: req('net.fetch', 'http://127.0.0.1:3000/'),
      tier: 'balanced',
      layers: withUserAllow,
    });
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('user.allow-localhost');
  });

  it('browser.control 同样受这条规则约束（同为 host kind，成本为零地补上）', () => {
    const v = judge({
      request: req('browser.control', 'http://169.254.169.254/'),
      tier: 'balanced',
      layers,
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('def.no-fetch-private-network-browser');
  });
});
