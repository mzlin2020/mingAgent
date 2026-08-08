import type { PolicyRule, PolicyRuleSet } from '@xm/contracts';
import { targetKindOf } from '@xm/contracts';
import { DENIED_COMMAND_BINS } from './command-claims.js';
import type { XmPaths } from '../port/platform.js';
import { xmDataLayout } from '../port/platform.js';
import type { RuleLayer } from './engine.js';
import { normalizedOrThrow } from './target.js';

/**
 * 红线所需的环境事实。
 *
 * **刻意做成必填参数，而不是内置常量。** 上一版红线把家目录写成字面量 `~`，把自改路径
 * 写成相对 glob——运行时传进来的却永远是展开后的绝对路径，于是两条红线在真实输入下
 * 一次也不会命中（实测见 tests/policy-redlines.test.ts）。
 *
 * 内核零 I/O，拿不到 `os.homedir()`，也就不该假装自己知道。把这两个事实变成
 * **调用方必须显式提供的入参**，是唯一能保证"红线里的路径和请求里的路径来自同一个
 * 坐标系"的做法：忘了传，编译不过；传错了，红线测试会红。
 */
export interface PolicyEnv {
  /** 用户主目录的绝对路径，如 `/home/ming`、`C:\Users\ming` */
  readonly home: string;
  /** 小明自身仓库/安装目录的绝对路径。L4 自我修改的红线全部相对它计算 */
  readonly appRoot: string;
  /**
   * 数据目录（事件库 / 审计库 / blob 都在这下面）。
   *
   * 同样必填，理由与上面两个一样，而且更具体：docs/06 §7 从一开始就写着
   * "小明自身的策略规则禁止写入审计库路径"，但直到 M0-b 开工前，代码里**一条对应规则
   * 都没有**——因为 `PolicyEnv` 拿不到这个目录，写不出那条规则。文档里的一句承诺，
   * 就这样安静地当了一个里程碑的摆设（ADR-0014）。
   *
   * 必须与 `home`/`appRoot` 出自同一次平台解析（`PlatformPort.paths()`），
   * 否则又是 ADR-0012 ①：规则里的路径和请求里的路径来自两个坐标系。
   */
  readonly dataDir: string;
}

/**
 * 内置策略。拼接顺序：**红线 → 平衡档默认 → 用户级 → 项目级**，
 * 同优先级内后定义者胜（见 engine.ts）。
 *
 * 两类规则的区别是本文件的核心：
 *   · **红线（immutable）** —— 任何档位、任何用户配置、YOLO 都不可覆盖。
 *     数量必须少。红线一多，用户就会去找绕过的办法，等于全部失效。
 *   · **默认规则** —— 用户可以覆盖，只是给出一个合理起点。
 */

/**
 * 红线。
 *
 * 挑选标准只有一条：**做了就回不来，且没有任何正当的自动化理由**。
 * "危险但有正当用途"的操作（rm -rf 某个构建目录、git push 到自己的分支）不属于红线，
 * 它们靠 ask + 还原点兜底。
 */
export const redLineRules = (env: PolicyEnv): readonly PolicyRule[] => {
  const home = normalizedOrThrow(env.home);
  const appRoot = normalizedOrThrow(env.appRoot);

  return [
  {
    id: 'red.fs-delete-filesystem-root',
    effect: 'deny',
    capability: 'fs.delete',
    match: { target: '/' },
    reason: '删除文件系统根目录。这不存在任何正当用途。',
    immutable: true,
  },
  /*
   * Windows 没有单一的 `/`——盘符根目录（`C:/`、`D:/`……）才是它的等价物。
   * `normalizePathTarget` 从不把两者归成同一个串（各自的坐标系不同），所以上面那条
   * 拦不住 `rm -rf C:\`。`?` 匹配单个非 `/` 字符（globMatch 的极简 glob 语法），
   * `?:/` 因此命中任意单字母盘符的根，不命中更深的路径。
   *
   * 这条红线在 M1-d 之前从未被真实触发过——能删除 `fs.delete` 的第一个真实调用点
   * 就是这一段的 `shell.exec`（ADR-0026）。命令拆出 `rm -rf /` 的主张后，网关按
   * 会话的 cwd 把 POSIX 写法的 `/` 解析成 Windows 上的当前盘符根，第一次真实喂给
   * 这两条红线时，只有大小写不敏感能救它们，坐标系本身对不上——2026-08-07 CI
   * 三平台矩阵的 windows-latest job 当场照出。
   */
  {
    id: 'red.fs-delete-drive-root',
    effect: 'deny',
    capability: 'fs.delete',
    match: { target: '?:/' },
    reason: '删除 Windows 盘符根目录。这不存在任何正当用途。',
    immutable: true,
  },
  {
    id: 'red.fs-delete-home-root',
    effect: 'deny',
    capability: 'fs.delete',
    match: { target: home },
    reason: '删除用户主目录。这不存在任何正当用途。',
    immutable: true,
  },
  {
    id: 'red.secrets-read-untrusted',
    effect: 'deny',
    capability: 'secrets.read',
    match: { trustLevel: ['untrusted'] },
    reason: '上下文含不可信内容时读取密钥。这是提示词注入窃取凭据的标准路径。',
    immutable: true,
  },
  {
    id: 'red.gui-input-untrusted',
    effect: 'deny',
    capability: 'gui.input',
    match: { trustLevel: ['untrusted'] },
    reason: '上下文含不可信内容时注入鼠标键盘。等于把电脑的控制权交给一个网页。',
    immutable: true,
  },
  {
    id: 'red.plugin-install-untrusted',
    effect: 'deny',
    capability: 'plugin.install',
    match: { trustLevel: ['untrusted'] },
    reason: '上下文含不可信内容时安装插件。这是让注入变成持久化后门的路径。',
    immutable: true,
  },
  /*
   * ── L4 自我修改的红线 ──
   *
   * 上一版只护住了 `packages/kernel/src/policy/**`。那是不够的，而且不够的方式很具体：
   * 判定逻辑改不了，**但判定的输入和护栏可以改**——
   *
   *   · 改 `contracts/src/permission/capability.ts` 删掉一个能力词条 → 所有针对它的规则
   *     变成死规则，PolicyEngine 一行没动却全面失效
   *   · 改 `scripts/check-secrets.mjs` → 密钥可以随提交外泄
   *   · 改 `.dependency-cruiser.cjs` / `eslint.config.js` → 架构护栏静默消失
   *     （ADR-0011 ⑨ 已经演示过一次：includeOnly 一行就让两条核心规则失效且输出全绿）
   *
   * 红线要护的从来不是某个文件，是**"改了它就没人拦得住后续改动"的那一组文件**。
   */
  ...selfModifyRedLines(appRoot),
  ...auditLogRedLines(env.dataDir),
  ];
};

/**
 * ── 审计日志的红线 ──
 *
 * docs/06 §7：审计库只增不改，"小明自身的策略规则禁止写入该路径"。
 * 这条承诺此前**没有任何代码实现**——`PolicyEnv` 里根本没有数据目录，写不出来。
 * 于是它和 ADR-0012 ⑧ 记下的那三个"文档里存在、代码里不存在"的扩展点是同一类东西。
 *
 * 为什么它值得当红线：审计日志是事后追责与小明自我审查的**唯一**依据。
 * 一个能改自己审计记录的 Agent，等于没有审计记录——而且是那种看起来还在的没有。
 *
 * 两个容易写错、写错就等于没写的细节：
 *
 *   · **必须盖住 `-wal` / `-shm`**。SQLite 的 WAL 模式下，尚未 checkpoint 的记录全在
 *     `audit.db-wal` 里。只护主文件，删掉 wal 就能抹掉最近一段审计——而主文件纹丝不动，
 *     看起来一切正常。这里用 `audit.db*`（极简 glob 的 `*` 不跨 `/`，正好只盖住边车文件）。
 *   · **只管工具发起的操作**。小明自己往审计库追加记录走的是存储适配器，不经过
 *     PolicyEngine；这里拦的是"模型让一个工具去动审计文件"，那才是攻击路径。
 *
 * `events.db` **刻意不设红线**。按本文件开头写下的挑选标准——红线只留"做了就回不来
 * 且没有任何正当理由"的操作——清空自己的会话数据是有正当用途的，它属于 `def.fs-delete`
 * 的 ask 加还原点。红线一多，用户就会去找绕过的办法，那才是真的全面失效。
 */
const auditLogRedLines = (dataDir: string): PolicyRule[] => {
  const { auditDb } = xmDataLayout(dataDir);
  const target = `${auditDb}*`;

  return [
    {
      id: 'red.audit-log-write',
      effect: 'deny',
      capability: 'fs.write',
      match: { target },
      reason: '写入审计日志。审计只增不改，可写的审计等于没有审计（docs/06 §7）。',
      immutable: true,
    },
    {
      id: 'red.audit-log-delete',
      effect: 'deny',
      capability: 'fs.delete',
      match: { target },
      reason: '删除审计日志。它是事后追责与自我审查的唯一依据（docs/06 §7）。',
      immutable: true,
    },
  ];
};

/** 修改即等于卸掉后续一切防护的文件。改动只能由人手工进行。 */
const SELF_MODIFY_PROTECTED: readonly { readonly glob: string; readonly why: string }[] = [
  { glob: 'packages/kernel/src/policy/**', why: '权限判定逻辑与红线清单自身' },
  { glob: 'packages/contracts/src/permission/**', why: '能力闭集与策略契约——删一个词条即让相关规则全部失效' },
  { glob: 'packages/contracts/src/config/secret.ts', why: '密钥引用契约' },
  { glob: 'packages/contracts/src/base/redact.ts', why: '日志与审计的统一脱敏出口' },
  { glob: 'scripts/**', why: '工具链与密钥扫描等提交前护栏' },
  { glob: '.dependency-cruiser.cjs', why: '架构依赖护栏' },
  { glob: 'eslint.config.js', why: '静态检查护栏' },
  { glob: '.githooks/**', why: '提交前钩子' },
  { glob: '.github/workflows/**', why: 'CI 流水线——改了它，上面所有护栏都可以不跑' },
];

/**
 * 每条受保护路径要挂的能力。
 *
 * ⚠️ **只挂 `self.modify` 是不够的，而且不够的方式很具体。** M0-b 复审实测：
 *
 * ```
 * self.modify 改 <appRoot>/packages/kernel/src/policy/defaults.ts → DENY [red.self-modify-00]
 * fs.write    改同一个文件                                        → ASK  [def.fs-write]
 * ```
 *
 * 能力是**工具自己声明**的。一个通用写文件工具声明的是 `fs.write`，它压根不知道
 * 自己正在改的是判定逻辑——于是九条自改红线被一个最普通的工具整体绕过，
 * 降级成一个用户会顺手点掉的确认框。
 *
 * 同一份代码里的审计库红线写对了（挂在 `fs.write` / `fs.delete` 上），
 * 自改红线写错了。这不是疏忽的两种，是同一个教训只学了一半：
 * **红线要按"目标是什么"来写，不能按"调用方自称在做什么"来写。**
 */
const SELF_MODIFY_GUARDED_CAPABILITIES = [
  { capability: 'self.modify' as const, suffix: '', verb: '修改' },
  { capability: 'fs.write' as const, suffix: '-fs-write', verb: '写入' },
  { capability: 'fs.delete' as const, suffix: '-fs-delete', verb: '删除' },
];

const selfModifyRedLines = (appRoot: string): PolicyRule[] =>
  SELF_MODIFY_PROTECTED.flatMap((p, i) => {
    const target = `${appRoot === '/' ? '' : appRoot}/${p.glob}`;
    const n = String(i).padStart(2, '0');

    return SELF_MODIFY_GUARDED_CAPABILITIES.map(({ capability, suffix, verb }) => ({
      id: `red.self-modify-${n}${suffix}`,
      effect: 'deny' as const,
      capability,
      match: { target },
      reason:
        `${verb}${p.why}。这类文件改掉之后，后续改动就没有任何东西拦得住了` +
        `（docs/07 §5）。只能由人手工进行。`,
      immutable: true,
    }));
  });

/**
 * 平衡档的默认规则（ADR-0003）。用户可覆盖。
 *
 * 取舍：读操作放行，写操作询问。这条线的依据是**可撤销性**——
 * 读不改变世界，写有还原点但需要用户知情。
 */
export const BALANCED_DEFAULT_RULES: readonly PolicyRule[] = [
  {
    id: 'def.fs-read',
    effect: 'allow',
    capability: 'fs.read',
    reason: '读取文件不改变任何状态',
    immutable: false,
  },
  {
    id: 'def.env-read',
    effect: 'allow',
    capability: 'env.read',
    reason: '读取环境变量不改变任何状态（值本身在日志里会被脱敏）',
    immutable: false,
  },
  {
    id: 'def.gui-capture',
    effect: 'ask',
    capability: 'gui.capture',
    reason: '截屏会把屏幕上的一切送进模型上下文，包括其它窗口里的内容',
    immutable: false,
  },
  {
    id: 'def.fs-write',
    effect: 'ask',
    capability: 'fs.write',
    reason: '写入文件会改变工作区',
    immutable: false,
  },
  {
    id: 'def.fs-delete',
    effect: 'ask',
    capability: 'fs.delete',
    reason: '删除文件',
    immutable: false,
  },
  {
    id: 'def.shell-exec',
    effect: 'ask',
    capability: 'shell.exec',
    reason: '执行命令的后果无法从命令行本身完全判断',
    immutable: false,
  },
  {
    id: 'def.git-write',
    effect: 'ask',
    capability: 'git.write',
    reason: '修改 git 仓库状态',
    immutable: false,
  },
  {
    id: 'def.git-push',
    effect: 'ask',
    capability: 'git.push',
    reason: '推送到远端不可撤销',
    immutable: false,
  },
  {
    id: 'def.net-fetch',
    effect: 'ask',
    capability: 'net.fetch',
    reason: '访问网络可能把工作区内容发送出去',
    immutable: false,
  },
  {
    id: 'def.package-install',
    effect: 'ask',
    capability: 'package.install',
    reason: '安装依赖会执行第三方的安装脚本',
    immutable: false,
  },
  {
    id: 'def.self-modify',
    effect: 'ask',
    capability: 'self.modify',
    reason: '修改小明自身的代码',
    immutable: false,
  },
];

// ── 敏感路径不许读 ──────────────────────────────────────────────

/**
 * `fs.read` 的敏感路径 deny（docs/06 §3，ADR-0025）。
 *
 * ── 为什么它必须存在 ──
 *
 * `def.fs-read` 是无条件 allow，理由写在那条规则上："读取文件不改变任何状态"。
 * 那句话在 M1-c 之前是对的——因为当时**没有任何工具真的能读文件**。M1-c 装上
 * `fs.read` / `fs.list` 之后它就变成了错的：读操作确实不改变磁盘，但它把内容
 * **搬进了模型上下文**，而模型上下文是会流向模型服务商的。对一个私钥来说，
 * 「被读到」和「被泄露」之间没有第二步。
 *
 * docs/06 §3 从第一版起就列着这批 deny，代码里一条也没有——本项目第 N 次
 * 「规则存在 ≠ 规则生效」，而这次连规则都只存在于文档里。
 *
 * ── 挑选标准（只有一条，写在这里是为了让后来加条目的人照着判断）──
 *
 * **这个文件的内容一旦进了模型上下文，就等于凭据已经泄露**，且拦掉它极少妨碍
 * 正经活儿。按这条标准：`*.pem` 进（EC2 密钥对就是这个后缀），`*.key` 不进
 * （太多东西用这个后缀，误伤远大于收益），`~/.bash_history` 不进
 * （里面**可能**有 token，但那是"可能"，不是"就是"）。
 *
 * ── 为什么是普通 deny 而不是红线 ──
 *
 * 红线不可覆盖，而"帮我看看这个项目的 .env 为什么没生效"是一个完全正当的请求。
 * 放成普通 deny，用户在自己的 `config.json` 里写一条 allow 就能放开（分层覆盖，
 * ADR-0023），而模型自己写不了那个文件——项目层只能收紧。红线留给
 * "做了就回不来"，这里是"做了就泄露了"，两者的正确解法不同：
 * 前者不给任何出口，后者给一个**用户显式打开**的出口。
 *
 * ── 三个平台的路径全都写上，且不做平台判断 ──
 *
 * 内核不知道自己跑在哪（ADR-0007）。`~/Library/Keychains/**` 在 Linux 上永远
 * 匹配不到任何东西，这不是浪费——它是**零成本**的，而少写它的代价是
 * 那个平台的凭据库整个敞着。docs/06 原来的清单是 macOS 视角的（只有 Keychains），
 * Windows 的 DPAPI 与 Linux 的 keyring 一条都没有。
 *
 * ⚠️ **写入侧还没做。** 这里拦的只有 `fs.read`。往 `~/.ssh/authorized_keys` 追加
 * 一行是一条标准的持久化后门，而它现在只是 `def.fs-write` 的一个 ask。
 * 见 ADR-0025 的遗留。
 */
interface SensitiveRead {
  readonly id: string;
  readonly glob: string;
  readonly why: string;
}

/** 家目录下的。`glob` 相对家目录，不带前导斜杠 */
const SENSITIVE_READ_UNDER_HOME: readonly SensitiveRead[] = [
  { id: 'ssh', glob: '.ssh/**', why: 'SSH 私钥与 known_hosts' },
  { id: 'gnupg', glob: '.gnupg/**', why: 'GPG 私钥环' },
  { id: 'aws', glob: '.aws/**', why: 'AWS 凭据' },
  { id: 'gcloud', glob: '.config/gcloud/**', why: 'Google Cloud 凭据' },
  { id: 'azure', glob: '.azure/**', why: 'Azure 凭据' },
  { id: 'kube', glob: '.kube/**', why: 'kubeconfig —— 里面就是集群的凭据' },
  { id: 'docker', glob: '.docker/config.json', why: '容器镜像仓库的登录凭据' },
  { id: 'netrc', glob: '.netrc', why: 'netrc 里是明文的账号密码' },
  { id: 'netrc-win', glob: '_netrc', why: 'netrc 的 Windows 写法' },
  // 操作系统的凭据库。小明自己的 API key 就存在这里面（ADR-0022），
  // 所以这几条同时也是"模型不能把小明自己的密钥读出来"。
  { id: 'keychain-macos', glob: 'Library/Keychains/**', why: 'macOS 钥匙串' },
  {
    id: 'dpapi-protect',
    glob: 'AppData/Roaming/Microsoft/Protect/**',
    why: 'Windows DPAPI 主密钥 —— 解得开凭据管理器里的一切',
  },
  {
    id: 'dpapi-crypto',
    glob: 'AppData/Roaming/Microsoft/Crypto/**',
    why: 'Windows 的私钥容器',
  },
  {
    id: 'credman',
    glob: 'AppData/Local/Microsoft/Credentials/**',
    why: 'Windows 凭据管理器',
  },
  { id: 'keyring-linux', glob: '.local/share/keyrings/**', why: 'Linux（GNOME）钥匙串' },
];

/** 任意目录下的。这批不挂在家目录上——它们跟着项目走 */
const SENSITIVE_READ_ANYWHERE: readonly SensitiveRead[] = [
  {
    id: 'dotenv',
    // `*` 不跨 `/`，所以这条盖住 `.env`、`.env.local`、`.envrc`，不会漫到别的目录
    glob: '**/.env*',
    why: '.env 文件几乎总是装着 API key 与数据库口令',
  },
  { id: 'pem', glob: '**/*.pem', why: 'PEM 文件通常就是私钥（EC2 密钥对即是此形态）' },
  { id: 'id-rsa', glob: '**/id_rsa*', why: 'SSH 私钥（被复制到工作区里的那一份）' },
  { id: 'id-dsa', glob: '**/id_dsa*', why: 'SSH 私钥' },
  { id: 'id-ecdsa', glob: '**/id_ecdsa*', why: 'SSH 私钥' },
  { id: 'id-ed25519', glob: '**/id_ed25519*', why: 'SSH 私钥' },
];

export const sensitiveReadRules = (env: PolicyEnv): readonly PolicyRule[] => {
  const home = normalizedOrThrow(env.home);
  const prefix = home === '/' ? '' : home;

  const rule = (s: SensitiveRead, target: string): PolicyRule => ({
    id: `def.no-read-${s.id}`,
    effect: 'deny',
    capability: 'fs.read',
    match: { target },
    reason:
      `${s.why}。读取不改变磁盘，但会把内容送进模型上下文——对凭据来说，` +
      `「被读到」和「被泄露」之间没有第二步。` +
      `确属你的本意的话，在用户配置里对这个路径写一条 allow 即可放开。`,
    immutable: false,
  });

  return [
    ...SENSITIVE_READ_UNDER_HOME.map((s) => rule(s, `${prefix}/${s.glob}`)),
    ...SENSITIVE_READ_ANYWHERE.map((s) => rule(s, s.glob)),
  ];
};

// ── 持久化路径不许写 ────────────────────────────────────────────

/**
 * 写入侧的敏感路径 deny（ADR-0027，ADR-0025 欠下的另一半）。
 *
 * ── 挑选标准（同样只有一条）──
 *
 * **写一次，之后每次开机 / 开终端 / 开某个工具都会自动执行。**
 *
 * 这批路径的共同形状不是"重要文件"，是**持久化**：改动本身不起眼，但它把一次性的
 * 越权变成了一个此后一直在的后门。`~/.ssh/authorized_keys` 里多一行公钥，
 * 攻击者从此可以直接登录；`.zshrc` 里多一行，此后每开一个终端都替他跑一次。
 *
 * ── 为什么必须是 deny，而不是留在 `def.fs-write` 的 ask ──
 *
 * 因为这批路径的攻击形态**恰恰就是一个用户会顺手点掉的确认框**。
 * 模型在长任务中间说一句"我需要写一下 shell 配置"，确认框和平时那些没有区别。
 * ADR-0025 对读取侧下过同一个判断，这里是它的对称面。
 *
 * ⚠️ **已知代价，照直说**：「帮我往 `.zshrc` 加个 alias」这类完全正当的请求会被拦。
 * 出口写在拒绝文案里——用户在自己的配置里对那个路径写一条 allow。
 * 这是刻意的取舍：出口存在、但必须由人显式打开，而不是在一个日常弹窗上顺手点。
 *
 * ── 为什么挂 `fs.write` 和 `fs.delete` 两个能力 ──
 *
 * 删掉 `.zshrc` 再写一个新的，与直接改它是同一件事。只挂写入侧，
 * 就留下了一条"先删后建"的路——而这正是 ADR-0014 那半个教训：
 * 规则要按**目标**写，不能按调用方自称在做哪一步写。
 */
interface PersistencePath {
  readonly id: string;
  readonly glob: string;
  readonly why: string;
}

/** 家目录下的。`glob` 相对家目录，不带前导斜杠 */
const PERSISTENCE_UNDER_HOME: readonly PersistencePath[] = [
  { id: 'authorized-keys', glob: '.ssh/authorized_keys', why: '写进去的公钥，此后可以直接登录这台机器' },
  { id: 'ssh-config', glob: '.ssh/config', why: 'SSH 配置里的 ProxyCommand / LocalCommand 会在每次连接时执行' },
  { id: 'bashrc', glob: '.bashrc', why: '每开一个 bash 都会执行' },
  { id: 'bash-profile', glob: '.bash_profile', why: '每次登录都会执行' },
  { id: 'bash-logout', glob: '.bash_logout', why: '每次退出终端都会执行' },
  { id: 'profile', glob: '.profile', why: '每次登录都会执行' },
  { id: 'zshrc', glob: '.zshrc', why: '每开一个 zsh 都会执行' },
  { id: 'zshenv', glob: '.zshenv', why: '每个 zsh 进程都会执行，连非交互的也算' },
  { id: 'zprofile', glob: '.zprofile', why: '每次登录都会执行' },
  { id: 'gitconfig', glob: '.gitconfig', why: 'git 的 alias 与 core.pager 是会被执行的命令' },
  { id: 'autostart', glob: '.config/autostart/**', why: '开机自启（Linux 桌面）' },
  { id: 'systemd-user', glob: '.config/systemd/user/**', why: '用户级 systemd 单元 —— 开机自启且能常驻' },
  { id: 'launch-agents', glob: 'Library/LaunchAgents/**', why: '开机自启（macOS）' },
  {
    id: 'startup-win',
    glob: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/**',
    why: '开机自启（Windows）',
  },
];

/** 跟着项目走的。它们不在家目录下，而是躺在任何一个工作区里 */
const PERSISTENCE_ANYWHERE: readonly PersistencePath[] = [
  {
    id: 'git-hooks',
    glob: '**/.git/hooks/**',
    why: 'git 钩子 —— 此后每次 commit / checkout 都会执行它，而这些命令用户自己每天都在敲',
  },
];

/** 与 `fs.write` 一样，删掉再重建是同一件事，所以两个能力都挂 */
const PERSISTENCE_CAPABILITIES = [
  { capability: 'fs.write' as const, suffix: '', verb: '写入' },
  { capability: 'fs.delete' as const, suffix: '-delete', verb: '删除' },
];

export const persistencePathRules = (env: PolicyEnv): readonly PolicyRule[] => {
  const home = normalizedOrThrow(env.home);
  const prefix = home === '/' ? '' : home;

  const rules = (p: PersistencePath, target: string): PolicyRule[] =>
    PERSISTENCE_CAPABILITIES.map(({ capability, suffix, verb }) => ({
      id: `def.no-write-${p.id}${suffix}`,
      effect: 'deny' as const,
      capability,
      match: { target },
      reason:
        `${verb}${p.why}。这类改动只发生一次，效果却是长期的——` +
        `一个确认框换来的是一个此后一直在的后门。` +
        `确属你的本意的话，在用户配置里对这个路径写一条 allow 即可放开。`,
      immutable: false,
    }));

  return [
    ...PERSISTENCE_UNDER_HOME.flatMap((p) => rules(p, `${prefix}/${p.glob}`)),
    ...PERSISTENCE_ANYWHERE.flatMap((p) => rules(p, p.glob)),
  ];
};

// ── 网络访问的 IP 级判定（SSRF）─────────────────────────────────

/**
 * `net.fetch` / `browser.control` 按解析出的 IP 拒绝内网/保留网段（M1-d）。
 *
 * ── 为什么必须存在 ──
 *
 * `def.net-fetch` 只是 `ask`——用户点一次允许，此后网关按域名写法归一之后就放行了。
 * `normalizeHostTarget` 自己写明了它的边界："归一之后的匹配仍然只是目的地写法层面的
 * 防线，真正的 SSRF 防御是在发请求的那一层按解析出的 IP 判定"。这条规则就是那一层——
 * 它匹配的不是 `target`（域名/字面量写法），而是 `ipRange`（网关解析域名之后拼出的
 * 第二条 claim，见 `packages/tools-core/src/gateway.ts`）。
 *
 * ── 为什么是普通 deny，不是红线 ──
 *
 * 挑选标准与 ADR-0025/0027 相同：访问内网/回环地址有大量正当用途——用户完全可能真的
 * 想让小明访问自己电脑上的 `localhost:3000` 开发服务器，或者局域网里的路由器管理页。
 * 云元数据地址（`169.254.169.254` 等）造成的伤害是"凭据进了模型上下文"，这与
 * ADR-0025 里 `.pem` 文件的伤害模型完全同构——而 `.pem` 本身也只是普通 deny，
 * 不是红线。红线不给任何出口，这里的正确解法是"给一个用户显式打开的出口"。
 *
 * `browser.control` 同为 `host` kind，一并挂上——M4 之前没有工具用到它，
 * 但补一条规则的成本是零，而漏掉的代价是那个能力接上工具的第一天就敞着（ADR-0025 的论证方式）。
 */
export const ssrfDenyRules = (): readonly PolicyRule[] =>
  (['net.fetch', 'browser.control'] as const).map((capability) => ({
    id: `def.no-fetch-private-network${capability === 'net.fetch' ? '' : '-browser'}`,
    effect: 'deny' as const,
    capability,
    match: { ipRange: 'private' as const },
    reason:
      '这个域名解析到了一个内网/保留网段的地址（含云元数据端点）。' +
      '这类地址背后的服务通常没有身份校验，一旦能被访问，凭据或内部接口就直接暴露给了模型上下文。' +
      '确属你的本意的话，在用户配置里对解析出的那个具体地址写一条 allow 即可放开。',
    immutable: false,
  }));

// ── 判不了的命令 ────────────────────────────────────────────────

/**
 * 几个**结构性地判不了**的 bin（ADR-0026 决策三）。
 *
 * 名单本身在 `command-claims.ts`（那里是唯一知道"哪些 bin 有画像"的地方），
 * 这里只把它翻译成规则——两处各写一份名单必然分叉，而分叉的表现是
 * 某个 bin 悄悄没人管了。
 *
 * 为什么是规则而不是在分析期直接抛错：抛错没有出口。用户完全可能就是想
 * `sudo apt install` 一下，那时他应该能在自己的配置里放开这一条
 * （ADR-0025 定下的形状：给不出出口的安全措施，最后都会被整体关掉）。
 *
 * 两条 glob 是必要的：本项目的极简 glob 里 `*` 不跨 `/`，而命令串里几乎一定有路径。
 * `sudo` 匹配它自己，`sudo **` 匹配它带参数的样子。
 */
const COMMAND_DENY_REASON: Readonly<Record<string, string>> = {
  sudo: '提权之后，本进程加的所有约束（env 白名单、工作目录、超时）都不再作数',
  su: '切换用户之后，本进程加的所有约束都不再作数',
  doas: '提权之后，本进程加的所有约束都不再作数',
  xargs: '它的参数来自标准输入，执行之前谁也不知道它会拿到什么',
  dd: '它的 if= / of= 是一套自成体系的参数语法，按普通操作数解出来的目标是错的',
};

export const commandDenyRules = (): readonly PolicyRule[] =>
  DENIED_COMMAND_BINS.flatMap((bin) =>
    [bin, `${bin} **`].map((target, i) => ({
      id: `def.no-exec-${bin}${i === 0 ? '' : '-args'}`,
      effect: 'deny' as const,
      capability: 'shell.exec' as const,
      match: { target },
      reason:
        `${COMMAND_DENY_REASON[bin] ?? '这条命令判不了'}，所以拆不出它到底会动什么。` +
        `判不出就不放行——确属你的本意的话，在用户配置里写一条 allow 放开它。`,
      immutable: false,
    })),
  );

/**
 * 规则集的**构造期**闸门（ADR-0020 决策三、四）。
 *
 * 两条，都是"写得出来就等于以为它生效了"那一类问题的唯一治法——在规则被**写下来的
 * 那一刻**炸掉，而不是等到某次判定悄悄不命中。
 *
 * ── 一、红线不得建立在没有规范化契约的 target 上 ──
 *
 * docs/09 G3：`path` 与 `host` 有规范化 + 失败关闭，`opaque` 只是个自由字符串。
 * 在 `opaque` 上写红线，看起来和写在路径上一模一样，实际是一条靠拼写巧合生效的规则。
 * **红线是最不能靠巧合的那一类规则**——它不可覆盖，用户没有别的手段兜底。
 *
 * ── 二、命令类能力不得用 glob 匹配 target ──
 *
 * `deny process.spawn "rm -rf /*"` 是 docs/06 里真写过的那种规则，而
 * `rm  -rf /`（两个空格）、`rm -fr /`、`/bin/rm -rf /`、`sh -c 'rm -rf /'` 全都绕得过去。
 * 契约落地之前，这种规则一条也不许存在——存在一条，就有人以为这里防住了。
 *
 * ── 三、`ipRange` 只能挂在 `host` kind 上 ──
 *
 * `matches()` 的 `ipRange` 分支只对 `host` kind 生效（非 host 一律不匹配），
 * 在别的能力上写这个字段不会报错也不会生效——一条"看起来配置了、实际是死规则"的
 * 规则，和"红线建在没有契约的 target 上"是同一类失效，同样要在写下来的那一刻炸掉。
 */
function assertRules(rules: PolicyRuleSet): PolicyRuleSet {
  for (const r of rules) {
    if (r.capability === '*') continue;
    const kind = targetKindOf(r.capability);

    if (r.match?.ipRange !== undefined && kind !== 'host') {
      throw new Error(
        `规则 "${r.id}" 对能力 "${r.capability}" 使用了 ipRange 匹配，而这个能力的` +
          `target kind 是 "${kind}" 不是 "host"——ipRange 判定只认已解析的网络地址，` +
          `在其它 kind 上它永远不会匹配，是一条看起来配置了、实际是死规则的规则。`,
      );
    }

    if (r.match?.target === undefined) continue;

    /*
     * ── 命令类 target：**红线仍然不许，普通规则放开**（ADR-0026 决策四，修正 ADR-0020 决策五）──
     *
     * 上一版是一刀切禁掉，理由是"同一条命令有无数种等价写法，glob 挡不住任何一种"。
     * 那个理由今天依然成立，所以红线那一半**一个字没改**——红线不可覆盖、
     * 用户没有兜底手段，它只能建立在有规范化契约、且契约足够强的 target 上。
     * `rm -fr /` 与 `rm -rf /` 归一之后仍然是两个串，命令串不够格。
     *
     * 但一刀切禁掉的同时也禁掉了两样必须存在的东西：
     *
     *   · **会话授权。** 「本会话允许这条命令」合成的正是一条带 target 的会话规则
     *     （`grantsToRules`）。禁掉它，用户唯一能点的就是"允许 `shell.exec` 这个能力"——
     *     一次授权放开的是**所有**命令。收紧不了的安全开关，比没有更糟。
     *   · **默认拒掉那几个判不了的 bin**（下方 `commandDenyRules`）。
     *
     * 这一半之所以现在可以放开，是因为命令 target 从"没有契约"变成了"有契约但不够强"
     * （ADR-0026 决策一）。有契约意味着同一条命令的写法差异不会让规则静默失效；
     * 不够强意味着它只能当便利过滤与授权的载体，真正的防线仍然是拆出来的那组主张。
     */
    if (kind === 'command' && r.immutable) {
      throw new Error(
        `红线 "${r.id}" 用 target 匹配命令类能力 "${r.capability}"，这不允许：` +
          `同一条命令有无数种等价写法（"rm -fr /" 与 "rm -rf /" 归一后仍是两个串），` +
          `glob 挡不住任何一种。红线不可覆盖、用户没有兜底手段，因此它只能建立在` +
          `路径或主机这类契约足够强的 target 上。要拦一条命令，让它拆出的**主张**去撞` +
          `按路径写的红线（ADR-0026 / docs/09 C4）。`,
      );
    }

    if (r.immutable && kind !== 'path' && kind !== 'host') {
      throw new Error(
        `红线 "${r.id}" 建立在能力 "${r.capability}" 的 target 上，而这类 target 没有规范化契约` +
          `（kind=${kind}）——它只是个自由字符串，改一下拼写就绕过去了。` +
          `红线不可覆盖、用户没有兜底手段，因此它只能建立在有规范化契约的 target 上（ADR-0020 决策四）。`,
      );
    }
  }
  return rules;
}

/**
 * 内置规则集 = 红线 + 平衡档默认 + 敏感路径不许读 + 持久化路径不许写 + 判不了的命令。
 *
 * 顺序按"从不可覆盖到可覆盖"读下来，但**判定与顺序无关**：层内永远是
 * deny > ask > allow，所以敏感路径的 deny 压得住 `def.fs-read` 的 allow，
 * 而它自己又压不住用户层——那正是想要的形状（ADR-0025）。
 *
 * 用户级与项目级规则是**后面的层**，从而能覆盖默认但覆盖不了红线。
 */
export const builtinRules = (env: PolicyEnv): PolicyRuleSet =>
  assertRules([
    ...redLineRules(env),
    ...BALANCED_DEFAULT_RULES,
    ...sensitiveReadRules(env),
    ...persistencePathRules(env),
    ...ssrfDenyRules(),
    ...commandDenyRules(),
  ]);

/** 只有内置一层的规则集。测试与 headless 里最常用的形状 */
export const builtinLayers = (env: PolicyEnv): readonly RuleLayer[] => [
  { id: 'builtin', rules: builtinRules(env) },
];

/**
 * `PlatformPort.paths()` → `PolicyEnv` 的**唯一**转换点。
 *
 * 存在的全部意义是消灭"两个坐标系"这个失效模式：调用方拿到一份 `XmPaths` 之后
 * 只能整份交过来，不能这里传解析出来的 data、那里手写一个 home。
 * ADR-0012 ① 就是手写那一半造成的。
 */
export const policyEnvFromPaths = (paths: XmPaths): PolicyEnv => ({
  home: paths.home,
  appRoot: paths.appRoot,
  dataDir: paths.data,
});

export interface ComposeInput {
  readonly env: PolicyEnv;
  /** 用户级配置文件里的规则。可以放松，也可以收紧 */
  readonly user?: PolicyRuleSet;
  /** 项目级 `.xiaoming/config.json` 里的规则。**必须先过 `tightenOnly()`** */
  readonly project?: PolicyRuleSet;
  /** 本会话的授权，由 `grantsToRules()` 合成 */
  readonly session?: PolicyRuleSet;
}

/**
 * 拼出分层规则。**顺序即优先级：后面的层胜**（求值细节见 engine.ts）。
 *
 * 每一层都过构造期闸门——用户级、项目级、会话授权才是最可能写出
 * "看起来在防、其实没防"的那一批（内置规则至少经过评审）。宁可让用户的配置文件
 * 在加载时报错，也不要让他以为自己已经挡住了 `rm -rf /`。
 *
 * ⚠️ 这个函数**不替调用方做 `tightenOnly`**。项目层能不能放松是一条安全取舍，
 * 它必须发生在调用方那里，因为被丢掉的规则要变成一条用户看得见的 notice——
 * 在这里悄悄过滤掉，用户就只会觉得"我写的规则没生效"。
 */
export function composeRules(input: ComposeInput): readonly RuleLayer[] {
  const layers: RuleLayer[] = [{ id: 'builtin', rules: builtinRules(input.env) }];
  if (input.user !== undefined && input.user.length > 0) {
    layers.push({ id: 'user', rules: input.user });
  }
  if (input.project !== undefined && input.project.length > 0) {
    layers.push({ id: 'project', rules: input.project });
  }
  if (input.session !== undefined && input.session.length > 0) {
    layers.push({ id: 'session', rules: input.session });
  }
  for (const layer of layers) assertRules(layer.rules);
  return layers;
}
