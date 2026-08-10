import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PermissionTier } from '@xm/contracts';
import {
  CRITICAL_UNDER_UNTRUSTED,
  IRREVERSIBLE_CAPABILITIES,
  newRequestId,
  newSessionId,
} from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { INJECTION_DOWNGRADE_RULE_ID, builtinRules, evaluate } from '@xm/kernel';

/**
 * ── 注入降级 × 审批档位（ADR-0035）──
 *
 * 用户第三次报同一个形状的反馈：开着「完全访问权限」搜一条今日新闻，
 * 仍然点了 10+ 次「允许」。根因在 `evaluate()` 的求值顺序上——
 * 第 4 步 YOLO 把 `ask` 变成 `allow`，第 5 步注入降级又把它 `allow → ask` 打回来。
 * 「别再问我」这个开关对**所有不可撤销能力**整体失效，而那正好是联网搜索走的那条路。
 *
 * 修法不是把防御关掉，是承认这个开关对绝大多数不可撤销操作已经是一次有效的预先回答，
 * 只对 `CRITICAL_UNDER_UNTRUSTED`（后果留在本会话之外的那几件事）保留提问。
 *
 * 本文件把整张降级矩阵钉死。它是安全边界，所以**按能力闭集遍历**，
 * 而不是挑几个代表——将来往 `IRREVERSIBLE_CAPABILITIES` 里加一个能力，
 * 这里会强迫加的人当场回答"它算不算严重项"。
 */

const ENV: PolicyEnv = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

/** 每个能力一个能过规范化的合法 target */
const TARGET_OF: Readonly<Record<Capability, string>> = {
  'fs.read': '/repo/a.ts',
  'fs.write': '/repo/a.ts',
  'fs.delete': '/repo/a.ts',
  'self.modify': '/repo/a.ts',
  'shell.session': '/repo',
  'shell.exec': '',
  'process.spawn': '',
  'net.fetch': 'https://example.com/x',
  'browser.control': 'https://example.com/x',
  'net.listen': '0.0.0.0:8080',
  'git.write': '/repo',
  'git.push': 'origin',
  'env.read': 'PATH',
  'secrets.read': 'OPENAI_KEY',
  'gui.capture': 'screen',
  'gui.input': 'keyboard',
  'package.install': 'lodash',
  'system.settings': 'dark-mode',
  'plugin.install': 'some-plugin',
};

const judge = (capability: Capability, tier: PermissionTier) => {
  const request: PermissionRequest = {
    requestId: newRequestId(),
    sessionId: newSessionId(),
    capability,
    target: TARGET_OF[capability],
    risk: 'medium',
    reason: '测试',
    trustLevel: 'untrusted',
  };
  return evaluate({
    request,
    layers: [{ id: 'builtin', rules: builtinRules(ENV) }],
    tier,
    untrustedSince: 1_000,
  });
};

/** 在不可信上下文下已经是红线硬拒绝的那几个 —— 它们在第 1 步就定案，走不到降级 */
const REDLINED_WHEN_UNTRUSTED: readonly Capability[] = [
  'secrets.read',
  'gui.input',
  'plugin.install',
];

const isRedlined = (c: Capability): boolean => REDLINED_WHEN_UNTRUSTED.includes(c);
const isCritical = (c: Capability): boolean => CRITICAL_UNDER_UNTRUSTED.includes(c);

describe('🔴 严重项这张表本身的不变量', () => {
  it('必须是不可撤销能力的子集 —— 否则那一条是死代码，降级根本不会碰到它', () => {
    for (const c of CRITICAL_UNDER_UNTRUSTED) {
      expect(IRREVERSIBLE_CAPABILITIES, c).toContain(c);
    }
  });

  it('不该和 `red.*-untrusted` 重复 —— 同一条规则写两处，迟早分叉', () => {
    for (const c of CRITICAL_UNDER_UNTRUSTED) {
      expect(REDLINED_WHEN_UNTRUSTED, c).not.toContain(c);
    }
  });
});

describe('yolo（帮我批准 / 完全访问权限）× 已污染', () => {
  it('🔴 非严重的不可撤销能力一律静默放行 —— 这就是用户要的那条', () => {
    for (const c of IRREVERSIBLE_CAPABILITIES) {
      if (isCritical(c) || isRedlined(c)) continue;
      const v = judge(c, 'yolo');
      expect(v.effect, c).toBe('allow');
      expect(v.ruleId, c).not.toBe(INJECTION_DOWNGRADE_RULE_ID);
    }
  });

  it('🔴 严重项仍然问一次 —— 后果留在本会话之外的，开关不替用户回答', () => {
    for (const c of CRITICAL_UNDER_UNTRUSTED) {
      const v = judge(c, 'yolo');
      expect(v.effect, c).toBe('ask');
      expect(v.ruleId, c).toBe(INJECTION_DOWNGRADE_RULE_ID);
    }
  });

  it('🔴 红线不受档位影响 —— 这是 ADR-0003 起的地基性质，本次一个字没动', () => {
    for (const c of REDLINED_WHEN_UNTRUSTED) {
      const v = judge(c, 'yolo');
      expect(v.effect, c).toBe('deny');
      expect(v.ruleId, c).toMatch(/^red\./);
    }
  });
});

describe('balanced（请求批准）× 已污染', () => {
  it('🔴 严重项仍然硬 deny —— ADR-0017 的 ask→deny 那一半原样保留', () => {
    for (const c of CRITICAL_UNDER_UNTRUSTED) {
      const v = judge(c, 'balanced');
      expect(v.effect, c).toBe('deny');
      expect(v.ruleId, c).toBe(INJECTION_DOWNGRADE_RULE_ID);
    }
  });

  it('非严重项停在高警示 ask —— 用户能只授权一个目标，而不是被迫解除整轮标记', () => {
    for (const c of IRREVERSIBLE_CAPABILITIES) {
      if (isCritical(c) || isRedlined(c)) continue;
      const v = judge(c, 'balanced');
      expect(v.effect, c).toBe('ask');
      // ruleId 换成注入降级自己的，UI 才知道要渲染成指名污染源的高警示样式
      expect(v.ruleId, c).toBe(INJECTION_DOWNGRADE_RULE_ID);
    }
  });
});

describe('🔴 降级只放松 ask，永远不松动 deny', () => {
  it('用户自己写的 deny 在 yolo + 已污染下仍然拦得住', () => {
    const v = evaluate({
      request: {
        requestId: newRequestId(),
        sessionId: newSessionId(),
        capability: 'net.fetch',
        target: 'https://example.com/x',
        risk: 'medium',
        reason: '测试',
        trustLevel: 'untrusted',
      },
      layers: [
        { id: 'builtin', rules: builtinRules(ENV) },
        {
          id: 'user',
          rules: [
            {
              id: 'u.no-example',
              effect: 'deny',
              capability: 'net.fetch',
              match: { target: 'example.com' },
              reason: '我不许碰这个域名',
              immutable: false,
            },
          ],
        },
      ],
      tier: 'yolo',
      untrustedSince: 1_000,
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('u.no-example');
  });
});

describe('干净上下文下什么都没变', () => {
  it('trustLevel 不是 untrusted 时，降级整段不参与判定', () => {
    for (const c of IRREVERSIBLE_CAPABILITIES) {
      for (const tier of ['balanced', 'yolo'] as const) {
        const v = evaluate({
          request: {
            requestId: newRequestId(),
            sessionId: newSessionId(),
            capability: c,
            target: TARGET_OF[c],
            risk: 'medium',
            reason: '测试',
            trustLevel: 'model',
          },
          layers: [{ id: 'builtin', rules: builtinRules(ENV) }],
          tier,
        });
        expect(v.ruleId, `${c}/${tier}`).not.toBe(INJECTION_DOWNGRADE_RULE_ID);
      }
    }
  });
});
