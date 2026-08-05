import type { PolicyRule, PolicyRuleSet } from '@xm/contracts';
import type { XmPaths } from '../port/platform.js';
import { xmDataLayout } from '../port/platform.js';
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

const selfModifyRedLines = (appRoot: string): PolicyRule[] =>
  SELF_MODIFY_PROTECTED.map((p, i) => ({
    id: `red.self-modify-${String(i).padStart(2, '0')}`,
    effect: 'deny' as const,
    capability: 'self.modify' as const,
    match: { target: `${appRoot === '/' ? '' : appRoot}/${p.glob}` },
    reason:
      `修改${p.why}。这类文件改掉之后，后续改动就没有任何东西拦得住了` +
      `（docs/07 §5）。只能由人手工进行。`,
    immutable: true,
  }));

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

/**
 * 内置规则集 = 红线 + 平衡档默认。
 * 用户级与项目级规则拼在它**后面**，从而能覆盖默认但覆盖不了红线。
 */
export const builtinRules = (env: PolicyEnv): PolicyRuleSet => [
  ...redLineRules(env),
  ...BALANCED_DEFAULT_RULES,
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

/** 拼接分层规则。顺序即优先级：后面的胜。 */
export const composeRules = (env: PolicyEnv, ...layers: readonly PolicyRuleSet[]): PolicyRuleSet => [
  ...builtinRules(env),
  ...layers.flat(),
];
