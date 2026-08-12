import { describe, expect, it } from 'vitest';
import type { PermissionRequest, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { builtinLayers, composeRules, evaluate, sensitiveReadRules } from '@xm/kernel';

/**
 * ── 敏感路径不许读（ADR-0025）──
 *
 * docs/06 §3 从第一版起就列着这批 deny，而在这个文件出现之前，代码里一条都没有：
 * `def.fs-read` 是无条件 allow，M1-c 又刚装上真实的 `fs.read`——
 * 模型可以直接把 `~/.ssh/id_rsa` 读进模型上下文。
 *
 * 这里钉住四件事，每一件错了都等于这批规则白写：
 *
 *   一、它真的压得住 `def.fs-read` 的 allow（同层内 deny > allow）
 *   二、它压不住用户自己写的 allow（分层覆盖，用户要有出口）
 *   三、YOLO 档跳不过它（docs/09 C5：YOLO 跳的是 ask，不是 deny）
 *   四、它只拦该拦的——`~/.sshfoo`、`environment.md` 这类不能误伤
 */

const HOME = '/home/ming';
const ENV: PolicyEnv = { home: HOME, appRoot: '/repo', dataDir: '/home/ming/.xiaoming', configDir: '/home/ming/.config/xiaoming' };

const ask = (target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability: 'fs.read',
  target,
  risk: 'safe',
  reason: '读文件',
  trustLevel: 'model',
});

const read = (target: string, options: { user?: PolicyRuleSet } = {}) =>
  evaluate({
    request: ask(target),
    layers: composeRules({ env: ENV, ...(options.user === undefined ? {} : { user: options.user }) }),
  });

describe('🔴 家目录下的凭据', () => {
  it.each([
    ['SSH 私钥', `${HOME}/.ssh/id_rsa`],
    ['SSH 目录自身（列目录也是 fs.read）', `${HOME}/.ssh`],
    ['GPG 私钥环', `${HOME}/.gnupg/private-keys-v1.d/x.key`],
    ['AWS 凭据', `${HOME}/.aws/credentials`],
    ['gcloud', `${HOME}/.config/gcloud/application_default_credentials.json`],
    ['kubeconfig', `${HOME}/.kube/config`],
    ['docker 登录', `${HOME}/.docker/config.json`],
    ['netrc', `${HOME}/.netrc`],
    ['macOS 钥匙串', `${HOME}/Library/Keychains/login.keychain-db`],
    ['Windows DPAPI 主密钥', `${HOME}/AppData/Roaming/Microsoft/Protect/S-1-5-21/abc`],
    ['Windows 凭据管理器', `${HOME}/AppData/Local/Microsoft/Credentials/abc`],
    ['Linux keyring', `${HOME}/.local/share/keyrings/login.keyring`],
  ])('%s → deny', (_label, target) => {
    expect(read(target).effect).toBe('deny');
  });

  /**
   * 三平台的路径**全都写上**，不做平台判断（ADR-0007：内核不知道自己跑在哪）。
   * docs/06 原来的清单只有 macOS 的 Keychains——按那份清单实现，
   * Windows 的 DPAPI 和 Linux 的 keyring 就整个敞着，而它们装的是同一批东西。
   */
  it('凭据库三个平台各有一条，一条都不能少', () => {
    const ids = sensitiveReadRules(ENV).map((r) => r.id);
    expect(ids).toContain('def.no-read-keychain-macos');
    expect(ids).toContain('def.no-read-dpapi-protect');
    expect(ids).toContain('def.no-read-keyring-linux');
  });
});

describe('🔴 跟着项目走的那批', () => {
  it.each([
    ['.env', '/work/proj/.env'],
    ['.env.local', '/work/proj/.env.local'],
    ['.envrc（direnv）', '/work/proj/.envrc'],
    ['深处的 .env', '/work/proj/a/b/c/.env'],
    ['仓库根的 .env', '/.env'],
    ['PEM（EC2 密钥对就是这个形态）', '/work/proj/deploy-key.pem'],
    ['被复制进工作区的 SSH 私钥', '/work/proj/keys/id_ed25519'],
  ])('%s → deny', (_label, target) => {
    expect(read(target).effect).toBe('deny');
  });

  /** 拦得太宽和拦得太窄一样糟：拦宽了用户就会去关掉整条规则 */
  it.each([
    ['名字里带 env 的普通文档', '/work/proj/environment.md'],
    ['不是 .env 开头', '/work/proj/my.env.example.md'],
    ['家目录下名字相近的目录', `${HOME}/.sshfoo/notes.txt`],
    ['公钥不拦（.pub 在 .ssh 之外）', '/work/proj/keys/deploy.pub'],
    ['普通源码', '/work/proj/src/index.ts'],
  ])('%s → 不受影响', (_label, target) => {
    expect(read(target).effect).not.toBe('deny');
  });
});

describe('这批 deny 在层序里的位置', () => {
  it('🔴 压得住 def.fs-read 的无条件 allow', () => {
    // 同一层里 deny > allow —— 这是它能生效的全部依据
    const verdict = evaluate({
      request: ask(`${HOME}/.aws/credentials`),
      layers: builtinLayers(ENV),
    });
    expect(verdict.effect).toBe('deny');
    expect(verdict.ruleId).toBe('def.no-read-aws');
  });

  /**
   * 用户必须有出口。"帮我看看这个项目的 .env 为什么没生效"是完全正当的请求，
   * 而模型自己写不了用户级配置——项目层只能收紧（`tightenOnly`）。
   */
  it('🔴 用户在自己的配置里放开某一个路径，就真的放开了', () => {
    const user: PolicyRuleSet = [
      {
        id: 'user.allow-proj-env',
        effect: 'allow',
        capability: 'fs.read',
        match: { target: '/work/proj/.env' },
        reason: '这个项目的 .env 我要它能看',
        immutable: false,
      },
    ];
    expect(read('/work/proj/.env', { user }).effect).toBe('allow');
    // 只放开了那一个，别的照拦
    expect(read('/work/other/.env', { user }).effect).toBe('deny');
    expect(read(`${HOME}/.ssh/id_rsa`, { user }).effect).toBe('deny');
  });

  /*
   * 这条以前叫"YOLO 档跳不过它"——档位删掉之后（ADR-0039）没有能跳过它的东西了，
   * 但断言本身仍然是这套规则最该被质疑的地方：**兜底放行不会顺带放开一条 deny。**
   */
  it('🔴 兜底放行跳不过它 —— 拒绝清单在前，兜底在后', () => {
    expect(read(`${HOME}/.ssh/id_rsa`).effect).toBe('deny');
    // 家目录下没在清单里的文件确实放行，说明拦住上面那条的是规则本身，不是"家目录不许读"
    expect(read(`${HOME}/notes.md`).effect).toBe('allow');
  });

  it('不是红线：它是可覆盖的，红线不是', () => {
    expect(sensitiveReadRules(ENV).every((r) => !r.immutable)).toBe(true);
  });

  it('verdict 里带得出理由和出口 —— 用户要知道为什么被拦、怎么放开', () => {
    const verdict = read(`${HOME}/.aws/credentials`);
    expect(verdict.reason).toContain('模型上下文');
    expect(verdict.reason).toContain('allow');
  });
});

describe('规则本身的形状', () => {
  it('只挂在 fs.read 上 —— 写入侧是另一笔账（ADR-0025 遗留）', () => {
    expect(sensitiveReadRules(ENV).every((r) => r.capability === 'fs.read')).toBe(true);
  });

  it('🔴 家目录是传进来的，不是字面量 `~`', () => {
    const other = sensitiveReadRules({ ...ENV, home: '/Users/other' });
    expect(other.some((r) => r.match?.target === '/Users/other/.ssh/**')).toBe(true);
    // 这条曾经真的写成过 `~`，于是在真实输入下永不命中（见 target.ts 开头）
    expect(other.every((r) => !(r.match?.target ?? '').includes('~'))).toBe(true);
  });

  it('Windows 家目录下同样成立', () => {
    const win: PolicyEnv = { home: 'C:\\Users\\ming', appRoot: 'C:\\repo', dataDir: 'C:\\data', configDir: 'C:\\config' };
    expect(
      evaluate({
        request: ask('C:/Users/ming/.ssh/id_rsa'),
        layers: builtinLayers(win),
      }).effect,
    ).toBe('deny');
  });
});
