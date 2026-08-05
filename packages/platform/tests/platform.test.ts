import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { builtinRules, evaluate, policyEnvFromPaths, xmDataLayout } from '@xm/kernel';
import { newRequestId, newSessionId } from '@xm/contracts';
import { nodePlatform, resolvePaths, withCapabilities } from '@xm/platform';

const APP_ROOT = '/opt/xiaoming';

describe('resolvePaths', () => {
  it('全部是已规范化的绝对路径', () => {
    const p = resolvePaths({ appRoot: APP_ROOT });
    const entries: readonly [string, string][] = [
      ['home', p.home],
      ['appRoot', p.appRoot],
      ['data', p.data],
      ['config', p.config],
      ['cache', p.cache],
      ['logs', p.logs],
    ];
    for (const [key, value] of entries) {
      expect(value, key).toMatch(/^(\/|[A-Z]:\/)/);
      expect(value, key).not.toContain('\\');
      expect(value, key).not.toContain('~');
      expect(value.endsWith('/'), key).toBe(false);
    }
  });

  it('目录名不带 env-paths 默认的 -nodejs 后缀', () => {
    // 用户会在文件管理器里看到这个目录名，`xiaoming-nodejs` 不合适
    expect(resolvePaths({ appRoot: APP_ROOT }).data).not.toContain('nodejs');
    expect(resolvePaths({ appRoot: APP_ROOT }).data).toContain('xiaoming');
  });

  it('home 覆盖与 dataDir 覆盖生效（测试与 headless 冒烟要用）', () => {
    const p = resolvePaths({ appRoot: APP_ROOT, home: '/tmp/h', dataDir: '/tmp/d' });
    expect(p.home).toBe('/tmp/h');
    expect(p.data).toBe('/tmp/d');
  });

  it('appRoot 不是绝对路径就直接抛 —— 构造期出错好过运行期失效', () => {
    expect(() => resolvePaths({ appRoot: 'packages/kernel' })).toThrow(/绝对路径/);
    expect(() => resolvePaths({ appRoot: '~/mingAgent' })).toThrow(/~/);
  });

  it('未覆盖时 home 就是真实家目录', () => {
    expect(resolvePaths({ appRoot: APP_ROOT }).home).toBe(homedir().replace(/\\/g, '/'));
  });
});

describe('nodePlatform', () => {
  it('能力报的是"地板"：没有外壳的东西一律不声明', () => {
    const caps = nodePlatform({ appRoot: APP_ROOT }).capabilities();
    expect(caps.tray).toBe(false);
    expect(caps.notifications).toBe(false);
    expect(caps.screenCapture).toBe(false);
    expect(caps.inputInjection).toBe(false);
  });

  it('密钥后端的地板是 encrypted-file，不是 plaintext-unavailable', () => {
    // 后者的含义是"必须拒绝存密钥"。纯 Node 下口令加密文件这条路永远走得通，
    // 谎报成不可用会让 M1 的 SecretStore 在本来能干活的环境里罢工
    expect(nodePlatform({ appRoot: APP_ROOT }).capabilities().secrets).toBe('encrypted-file');
  });

  it('withCapabilities 只抬能力，路径原样透传', () => {
    const base = nodePlatform({ appRoot: APP_ROOT, dataDir: '/tmp/d' });
    const raised = withCapabilities(base, { tray: true, secrets: 'keychain' });
    expect(raised.capabilities().tray).toBe(true);
    expect(raised.capabilities().secrets).toBe('keychain');
    expect(raised.capabilities().inputInjection).toBe(false);
    expect(raised.paths()).toEqual(base.paths());
    expect(raised.os).toBe(base.os);
  });

  it('os 是三选一的闭集', () => {
    expect(['macos', 'windows', 'linux']).toContain(nodePlatform({ appRoot: APP_ROOT }).os);
  });
});

/**
 * 本文件真正要证明的一条：**红线保护的是运行时真实存在的那个路径**。
 *
 * ADR-0012 ① 的失效形态是"规则里的路径和请求里的路径来自两个坐标系"，
 * 而它之所以能发生，是因为两边各自算了一次路径。现在只有一条通路：
 * `PlatformPort.paths()` → `policyEnvFromPaths()` → `builtinRules()`，
 * 而请求里的路径由同一份 `xmDataLayout()` 给出。下面把这条通路整段跑一遍。
 */
describe('平台路径 → 红线 的整段接线', () => {
  it('🔴 真实解析出来的审计库路径确实被红线拦住', () => {
    const platform = nodePlatform({ appRoot: APP_ROOT });
    const rules = builtinRules(policyEnvFromPaths(platform.paths()));
    const { auditDb } = xmDataLayout(platform.paths().data);

    const v = evaluate({
      request: {
        requestId: newRequestId(),
        sessionId: newSessionId(),
        capability: 'fs.delete',
        target: auditDb,
        risk: 'high',
        reason: '演练',
        trustLevel: 'model',
      },
      rules,
      tier: 'yolo',
      pathCaseInsensitive: platform.os === 'windows',
    });

    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('red.audit-log-delete');
  });
});
