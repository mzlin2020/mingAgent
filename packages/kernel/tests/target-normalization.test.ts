import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRule } from '@xm/contracts';
import { ALL_CAPABILITIES, newRequestId, newSessionId, targetKindOf } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import {
  builtinRules,
  composeRules,
  evaluate,
  globMatch,
  normalizeHostTarget,
  normalizeTarget,
} from '@xm/kernel';

/**
 * 单层求值的便捷包装。
 *
 * 本文件里的用例考的是**层内**语义（deny > ask > allow、后定义者胜、匹配条件、红线），
 * 那些在分层之后一个字都没变，所以把整份规则放进一层是忠实的翻译。
 * **层间**语义（后一层压过前一层、项目层只能收紧、会话授权）在
 * `policy-layers.test.ts` 里单独考，那里必须显式写出层。
 */
type EvalInput = Parameters<typeof evaluate>[0];
const judge = (
  input: Omit<EvalInput, 'layers'> & { rules: EvalInput['layers'][number]['rules'] },
): ReturnType<typeof evaluate> => {
  const { rules, ...rest } = input;
  return evaluate({ ...rest, layers: [{ id: 'builtin', rules }] });
};

/**
 * ── 非路径能力的 target 规范化契约（docs/09 C4 / G3，ADR-0020）──
 *
 * 路径那一种在 ADR-0012 ① 付过一次学费：红线写一种写法、请求传另一种写法，
 * 两边都"是路径"，匹配却永不命中，而输出一直是"规则已配置"。修法是规范化 + 失败关闭。
 *
 * 这个文件把同一套要求推广到其余三种 target 语义，并且**逐条演示不做会怎样**——
 * 下面每一个"绕过"都是一条真实可用的绕过手段，不是假想的。
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

const ok = (raw: string): string => {
  const r = normalizeHostTarget(raw);
  if (!r.ok) throw new Error(`本该归一成功：${raw} —— ${r.reason}`);
  return r.value;
};

describe('每个能力恰好一种 target 语义', () => {
  it('闭集里每个能力都有归属，没有沉默的缺省分支', () => {
    for (const c of ALL_CAPABILITIES) {
      expect(['path', 'host', 'command', 'opaque'], c).toContain(targetKindOf(c));
    }
  });

  it('net.listen 不是 host —— 绑定地址和"要访问哪个远端"是相反方向的东西', () => {
    expect(targetKindOf('net.listen')).toBe('opaque');
    expect(targetKindOf('net.fetch')).toBe('host');
  });
});

describe('host 归一：同一个目的地的不同写法必须得到同一个字符串', () => {
  const CANONICAL = 'x.evil.com';

  it.each([
    ['https://x.evil.com/a?b#c', '普通形态'],
    ['https://X.EVIL.COM/', '大小写 —— DNS 不区分大小写'],
    ['https://x.evil.com:443/', '默认端口'],
    ['https://x.evil.com./', 'FQDN 尾点'],
    ['https://good.com@x.evil.com/', 'userinfo —— 真实主机在 @ 之后，人眼和朴素规则都会看错'],
    ['https://X.Evil.Com.:443/path', '以上全都叠在一起'],
  ])('%s → x.evil.com（%s）', (raw) => {
    expect(ok(raw)).toBe(CANONICAL);
  });

  it('非默认端口保留 —— 归一不是抹平信息', () => {
    expect(ok('https://x.evil.com:8443/')).toBe('x.evil.com:8443');
    expect(ok('http://x.evil.com:80/')).toBe('x.evil.com');
    // http 的默认端口是 80，所以 443 在 http 下**不是**默认端口
    expect(ok('http://x.evil.com:443/')).toBe('x.evil.com:443');
  });

  it('点分四段 IP 通过，其它进制一律拒绝 —— 它们都指向同一台机器', () => {
    expect(ok('http://127.0.0.1:8080/')).toBe('127.0.0.1:8080');
    for (const raw of [
      'http://2130706433/', // 十进制
      'http://0177.0.0.1/', // 八进制
      'http://0x7f.1/', // 十六进制混写
      'http://127.1/', // 短写
    ]) {
      expect(normalizeHostTarget(raw).ok, raw).toBe(false);
    }
  });

  it('百分号编码与非 ASCII 拒绝 —— 解码与 IDNA 都不是内核干得了的事', () => {
    expect(normalizeHostTarget('http://ev%69l.com/').ok).toBe(false);
    // 西里尔 е。和 evil.com 在屏幕上一模一样
    expect(normalizeHostTarget('https://еvil.com/').ok).toBe(false);
  });

  it('🔴 非 http(s) 一律拒绝 —— 否则 net.fetch 就是一条绕开所有 fs 规则的读文件路径', () => {
    for (const raw of ['file:///etc/passwd', 'data:text/html,x', 'ftp://x.com/', 'javascript:x']) {
      expect(normalizeHostTarget(raw).ok, raw).toBe(false);
    }
  });

  it('裸主机名拒绝 —— "a:b" 有两种读法，安全边界上不接受有歧义的输入', () => {
    expect(normalizeHostTarget('evil.com').ok).toBe(false);
    expect(normalizeHostTarget('evil.com:8080').ok).toBe(false);
  });

  it('IPv6 归一到 RFC 5952 —— 同一个地址的四种写法必须收敛', () => {
    for (const raw of [
      'http://[::1]/',
      'http://[0:0:0:0:0:0:0:1]/',
      'http://[0000:0000:0000:0000:0000:0000:0000:0001]/',
      'http://[::0001]/',
    ]) {
      expect(ok(raw), raw).toBe('[::1]');
    }
    // 末尾带 IPv4 段的两种形态：`::` 之后有组、以及 `::` 紧挨着 v4
    expect(ok('http://[::ffff:127.0.0.1]:8080/')).toBe('[::ffff:7f00:1]:8080');
    expect(ok('http://[::1.2.3.4]/')).toBe('[::102:304]');
    expect(ok('http://[1:2:3:4:5:6:1.2.3.4]/')).toBe('[1:2:3:4:5:6:102:304]');
    // 最长零段压缩，并列取最左
    expect(ok('http://[2001:db8:0:0:1:0:0:1]/')).toBe('[2001:db8::1:0:0:1]');
    expect(normalizeHostTarget('http://[::1::2]/').ok).toBe(false);
    expect(normalizeHostTarget('http://[fe80::1%eth0]/').ok).toBe(false);
  });
});

describe('host glob：`*.` 也命中域名自身', () => {
  it('*.evil.com 命中 evil.com、子域，不命中 notevil.com', () => {
    expect(globMatch('*.evil.com', 'evil.com', false, 'host')).toBe(true);
    expect(globMatch('*.evil.com', 'x.evil.com', false, 'host')).toBe(true);
    expect(globMatch('*.evil.com', 'a.b.evil.com', false, 'host')).toBe(true);
    expect(globMatch('*.evil.com', 'notevil.com', false, 'host')).toBe(false);
    expect(globMatch('*.evil.com', 'evil.com.attacker.net', false, 'host')).toBe(false);
  });

  it('path 语义不受影响 —— 只给 host 开了这条口子', () => {
    expect(globMatch('*.evil.com', 'evil.com', false, 'path')).toBe(false);
    expect(globMatch('/prod/**', '/prod', false, 'path')).toBe(true);
  });
});

describe('端到端：deny net.fetch *.evil.com 挡得住全部写法', () => {
  const RULES: PolicyRule[] = [
    {
      id: 'user.no-evil',
      effect: 'deny',
      capability: 'net.fetch',
      match: { target: '*.evil.com' },
      reason: '这个域名不许访问',
      immutable: false,
    },
  ];

  it.each([
    'https://evil.com/',
    'https://x.evil.com/',
    'https://EVIL.com/',
    'https://evil.com./',
    'https://x.evil.com:443/',
    'https://good.com@evil.com/',
  ])('%s → deny', (target) => {
    const v = judge({ request: req('net.fetch', target), rules: RULES });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('user.no-evil');
  });

  it('判不了的写法也是 deny，而不是悄悄落到 ask', () => {
    // ask 的下一步是用户点"允许"，所以判不了必须比 ask 更严
    const v = judge({
      request: req('net.fetch', 'http://2130706433/'),
      rules: RULES,
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('builtin.invalid-target');
  });

  it('无关域名照常放行 —— 防线不能宽到把一切都拦下', () => {
    const v = judge({
      request: req('net.fetch', 'https://good.example/'),
      rules: [...RULES, ...builtinRules(ENV)],
    });
    expect(v.effect).toBe('allow');
  });
});

/**
 * command 的契约在 ADR-0026 落地了。这一组从"闸门失败关闭"改成"归一之后照常判"，
 * 但**判不了的构造仍然失败关闭**——那一半一个字没松。
 */
describe('command：归一到规范形式，判不了的仍然失败关闭', () => {
  it('带 target 的命令类判定不再一律 deny —— 它现在有契约了', () => {
    const v = judge({
      request: req('shell.exec', 'git push'),
      rules: builtinRules(ENV),
    });
    expect(v.effect).toBe('allow');
  });

  it('🔴 展开结果取决于运行时环境的写法，照旧 deny', () => {
    const v = judge({
      request: req('shell.exec', 'rm -rf $(cat target)'),
      rules: builtinRules(ENV),
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('builtin.invalid-target');
  });

  it('🔴 YOLO 也跳不过去 —— 它跳的是 ask，不是 deny', () => {
    const v = judge({
      request: req('shell.exec', 'rm -rf /tmp/*'),
      rules: builtinRules(ENV),
    });
    expect(v.effect).toBe('deny');
  });

  it('🔴 判不了的那几个 bin 有内置 deny，且用户可以覆盖', () => {
    const denied = judge({
      request: req('shell.exec', 'sudo rm -rf /'),
      rules: builtinRules(ENV),
    });
    expect(denied.effect).toBe('deny');
    expect(denied.ruleId).toBe('def.no-exec-sudo-args');
  });

  it('空 target 照常走能力级规则 —— 闸门拦的是假防线，不是能力本身', () => {
    const v = judge({
      request: req('shell.exec', ''),
      rules: builtinRules(ENV),
    });
    // 没有任何规则拦 `shell.exec` 了，但重点是它**没有因为 target 为空而失败关闭**
    expect(v.effect).toBe('allow');
    expect(v.ruleId).not.toBe('builtin.invalid-target');
  });

  it('normalizeTarget 直接问也是同一个答案', () => {
    expect(normalizeTarget('shell.exec', '').ok).toBe(true);
    expect(normalizeTarget('process.spawn', '/bin/ls  -l')).toEqual({ ok: true, value: 'ls -l' });
    expect(normalizeTarget('process.spawn', 'ls $HOME').ok).toBe(false);
  });
});

describe('🔴 构造期闸门：写不出假防线', () => {
  const bad = (r: Partial<PolicyRule>): PolicyRule => ({
    id: 'x',
    effect: 'deny',
    capability: 'shell.exec',
    reason: 'r',
    immutable: false,
    ...r,
  });

  it('🔴 命令类能力上的**红线**仍然不许用 target 匹配 —— 写下的那一刻就炸', () => {
    // 归一之后 `rm -fr /` 与 `rm -rf /` 还是两个串。命令串够格当便利过滤与授权的载体，
    // 不够格当红线——红线不可覆盖，用户没有兜底手段（ADR-0026 决策四）
    expect(() =>
      composeRules({ env: ENV, user: [bad({ immutable: true, match: { target: 'rm -rf /*' } })] }),
    ).toThrow(/命令类能力/);
  });

  it('普通规则可以匹配命令 —— 否则用户没法在配置里放开某一条具体命令', () => {
    expect(() =>
      composeRules({ env: ENV, user: [bad({ effect: 'allow', match: { target: 'ls -l' } })] }),
    ).not.toThrow();
  });

  it('红线不许建立在 opaque target 上 —— 它只是个自由字符串', () => {
    expect(() =>
      composeRules({
        env: ENV,
        user: [bad({ capability: 'git.push', immutable: true, match: { target: 'origin' } })],
      }),
    ).toThrow(/没有规范化契约/);
  });

  it('普通规则用 opaque target 允许 —— 便利过滤不是安全边界，但它有用', () => {
    expect(() =>
      composeRules({ env: ENV, user: [bad({ capability: 'git.push', match: { target: 'origin' } })] }),
    ).not.toThrow();
  });

  it('内置红线自己全部合规', () => {
    expect(() => builtinRules(ENV)).not.toThrow();
  });
});
