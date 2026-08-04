import type { PolicyRule, PolicyRuleSet } from '@xm/contracts';

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
export const RED_LINE_RULES: readonly PolicyRule[] = [
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
    match: { target: '~' },
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
  {
    id: 'red.self-modify-policy',
    effect: 'deny',
    capability: 'self.modify',
    match: { target: '**/packages/kernel/src/policy/**' },
    reason:
      '修改权限判定与红线清单自身。红线能被自己改掉，就等于没有红线（docs/07 §5）。' +
      '这类改动只能由人手工进行。',
    immutable: true,
  },
];

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
export const BUILTIN_RULES: PolicyRuleSet = [...RED_LINE_RULES, ...BALANCED_DEFAULT_RULES];

/** 拼接分层规则。顺序即优先级：后面的胜。 */
export const composeRules = (...layers: readonly PolicyRuleSet[]): PolicyRuleSet => [
  ...BUILTIN_RULES,
  ...layers.flat(),
];
