import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { builtinLayers, composeRules, evaluate, persistencePathRules } from '@xm/kernel';

/**
 * ── 持久化路径不许写（ADR-0027）──
 *
 * ADR-0025 的对称面。读取侧拦的是"内容进了上下文就等于泄露"，
 * 这里拦的是"写一次，之后每次开机 / 开终端都会替他跑一遍"。
 *
 * 钉住的四件事与 ADR-0025 同构，因为它们是同一个判断的两半：
 *   一、压得住 `def.fs-write` 的 ask（同层内 deny > ask）
 *   二、压不住用户自己写的 allow —— 用户必须有出口
 *   三、YOLO 跳不过
 *   四、写和删两侧都堵上 —— 删掉再重建与直接改是同一件事
 */

const HOME = '/home/ming';
const ENV: PolicyEnv = { home: HOME, sourceRoot: '/repo', dataDir: '/home/ming/.xiaoming', configDir: '/home/ming/.config/xiaoming' };

const ask = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'medium',
  reason: '写文件',
  trustLevel: 'model',
});

const judge = (capability: Capability, target: string, options: { user?: PolicyRuleSet } = {}) =>
  evaluate({
    request: ask(capability, target),
    layers: composeRules({ env: ENV, ...(options.user === undefined ? {} : { user: options.user }) }),
  });

describe('🔴 开机 / 开终端就会执行的那批', () => {
  it.each([
    ['authorized_keys —— 写进去就能直接登录', `${HOME}/.ssh/authorized_keys`],
    ['SSH config —— ProxyCommand 会被执行', `${HOME}/.ssh/config`],
    ['bashrc', `${HOME}/.bashrc`],
    ['zshrc', `${HOME}/.zshrc`],
    ['zshenv —— 连非交互的 zsh 都会执行', `${HOME}/.zshenv`],
    ['profile', `${HOME}/.profile`],
    ['gitconfig —— alias 与 core.pager 是会被执行的命令', `${HOME}/.gitconfig`],
    ['Linux 开机自启', `${HOME}/.config/autostart/evil.desktop`],
    ['用户级 systemd 单元', `${HOME}/.config/systemd/user/evil.service`],
    ['macOS 开机自启', `${HOME}/Library/LaunchAgents/evil.plist`],
    [
      'Windows 开机自启',
      `${HOME}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/evil.lnk`,
    ],
    ['git 钩子 —— 跟着项目走，不在家目录下', '/work/proj/.git/hooks/pre-commit'],
  ])('%s → 写入 deny', (_label, target) => {
    expect(judge('fs.write', target).effect).toBe('deny');
  });

  it('🔴 删除侧同样堵上 —— 删掉再重建与直接改是同一件事', () => {
    expect(judge('fs.delete', `${HOME}/.zshrc`).effect).toBe('deny');
    expect(judge('fs.delete', '/work/proj/.git/hooks/pre-commit').effect).toBe('deny');
  });

  it('读不受影响 —— 想知道 .zshrc 里写了什么是完全正当的', () => {
    expect(judge('fs.read', `${HOME}/.zshrc`).effect).not.toBe('deny');
  });
});

describe('不能误伤', () => {
  it.each([
    ['工作区里的普通文件', '/work/proj/src/index.ts'],
    ['名字相近的目录', `${HOME}/.zshrc.d/x.zsh`],
    ['不是 .git/hooks', '/work/proj/hooks/pre-commit'],
    ['.git 里的其它东西（提交本身要写它）', '/work/proj/.git/index'],
  ])('%s → 不受影响', (_label, target) => {
    expect(judge('fs.write', target).effect).not.toBe('deny');
  });
});

describe('层序里的位置', () => {
  it('🔴 压得住 def.fs-write 的 ask', () => {
    const v = evaluate({
      request: ask('fs.write', `${HOME}/.bashrc`),
      layers: builtinLayers(ENV),
    });
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('def.no-write-bashrc');
  });

  it('🔴 用户放开某一个路径就真的放开了 —— 「帮我加个 alias」要有出口', () => {
    const user: PolicyRuleSet = [
      {
        id: 'user.allow-zshrc',
        effect: 'allow',
        capability: 'fs.write',
        match: { target: `${HOME}/.zshrc` },
        reason: '我的 zshrc 我自己知道',
        immutable: false,
      },
    ];
    expect(judge('fs.write', `${HOME}/.zshrc`, { user }).effect).toBe('allow');
    // 只放开了那一个
    expect(judge('fs.write', `${HOME}/.bashrc`, { user }).effect).toBe('deny');
    expect(judge('fs.write', `${HOME}/.ssh/authorized_keys`, { user }).effect).toBe('deny');
  });

  /* 同 policy-sensitive-read：档位没了，但"兜底放行不会放开一条 deny"这条要留着 */
  it('🔴 兜底放行跳不过它', () => {
    expect(judge('fs.write', `${HOME}/.ssh/authorized_keys`).effect).toBe('deny');
    expect(judge('fs.write', `${HOME}/notes.md`).effect).toBe('allow');
  });

  it('不是红线：可覆盖', () => {
    expect(persistencePathRules(ENV).every((r) => !r.immutable)).toBe(true);
  });

  it('拒绝文案里带着出口', () => {
    const v = judge('fs.write', `${HOME}/.bashrc`);
    expect(v.reason).toContain('allow');
  });

  it('家目录是传进来的，不是字面量 `~`', () => {
    const other = persistencePathRules({ ...ENV, home: '/Users/other' });
    expect(other.some((r) => r.match?.target === '/Users/other/.zshrc')).toBe(true);
    expect(other.every((r) => !(r.match?.target ?? '').includes('~'))).toBe(true);
  });
});
