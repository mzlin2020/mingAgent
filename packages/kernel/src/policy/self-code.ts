import type { PolicyRule } from '@xm/contracts';
import { normalizedOrThrow } from './target.js';

/**
 * L4 自我修改的红线 —— **哪些文件不许小明自己动，以及那些文件在哪**（ADR-0078）。
 *
 * 这个文件从 `defaults.ts` 拆出来，不是为了行数：拆出来之后，"受保护的是哪些文件"
 * 与"那份清单锚在哪棵树上"变成两个能各自被闸门盯住的东西。
 * 地基复审四抓到的两个缺陷恰好各占一个：
 *
 *   · **清单腐烂**（A2）：M3 把网关搬进 `tool-runtime`、把十二步链拆出 `turn.ts`、
 *     把装配改名成 `desktop-host.ts`，清单一条没跟着改。于是三条规则护着已经不存在的
 *     文件，而真正的网关、十二步链、容器、装配全部裸奔。实测：`fs.write` 打到
 *     `packages/tool-runtime/src/gateway.ts` 得到 `allow(builtin.no-rule-matched)`。
 *     闸门：`scripts/check-redline-targets.mjs`，每条 glob 必须在仓库里匹配到真实文件。
 *
 *   · **锚点指错**（A1）：`appRoot` 曾经取 `app.getAppPath()`，那是**入口所在目录**——
 *     开发时是 `apps/desktop`，打包后是 `resources/app.asar`。两种情形下
 *     `<appRoot>/packages/kernel/src/policy/**` 都不指向任何真实文件，
 *     整族红线在真实运行里一次也不会命中。测试全绿是因为它们喂的是合成的 `/repo`。
 *     现在锚点分成三种、各有各的名字与来源，见 `SelfCodeRoots`。
 *
 * ── 为什么红线要按"目标是什么"写 ──
 *
 * 每条受保护路径同时挂三个能力（`self.modify` / `fs.write` / `fs.delete`）。
 * 能力是**工具自己声明**的：一个通用写文件工具声明的是 `fs.write`，它压根不知道自己
 * 正在改判定逻辑。只挂 `self.modify` 的那一版被一个最普通的写文件工具整体绕过（ADR-0017）。
 */

/** 一棵"小明自己的代码树"的形态。两种形态受保护的东西完全不同，所以分开表达。 */
export interface SelfCodeRoots {
  /**
   * 源码树的根：有 `packages/` 与 `apps/` 的那一棵。受保护的是下面 `SELF_MODIFY_PROTECTED`
   * 那份清单里的文件，**不是整棵树**——小明改自己的文档、测试、非护栏代码是 L3 允许的事。
   */
  readonly sourceRoot: string;
  /**
   * 额外的源码树。典型来源：**会话的工作目录恰好是另一份小明的检出**——
   * 用打包版小明去改一份 clone 出来的源码，正是"改进自己"最真实的形态，
   * 而那棵树与正在运行的这棵没有任何关系，锚点不覆盖它就等于不设防。
   */
  readonly extraSourceRoots?: readonly string[];
  /**
   * 打包安装目录（`app.isPackaged` 时才有）。这里**整棵树**禁写禁删：
   * asar 里没有源码，能改的只有可执行文件、原生模块与 asar 本身，
   * 而这三样里的任何一样被改掉，上面那份清单就全都不作数了。
   */
  readonly installRoot?: string;
}

/**
 * 修改即等于卸掉后续一切防护的文件。改动只能由人手工进行。
 *
 * ⚠️ **清单里的每一条都必须在仓库里匹配到真实文件**，由 `pnpm check:redlines` 强制。
 * 这条闸门存在的唯一理由是 A2：一次重命名就能让一条红线安静地保护一个不存在的路径，
 * 而 depcruise、typecheck、全部用例都不会因此变红。
 *
 * `slug` 进规则 ID（`red.self-modify.kernel-policy-fs-write`）。**不许用数组下标**——
 * 下标会让"往中间插一条"把后面所有规则的 ID 平移，而 `ruleId` 是落库的审计字段，
 * 平移之后历史事件里的那个 ID 指向了另一条规则。
 */
export const SELF_MODIFY_PROTECTED: readonly {
  readonly slug: string;
  readonly glob: string;
  readonly why: string;
}[] = [
  // ── 判定与契约 ──
  { slug: 'kernel-policy', glob: 'packages/kernel/src/policy/**', why: '权限判定逻辑与红线清单自身' },
  { slug: 'kernel-container', glob: 'packages/kernel/src/container/**', why: '插件容器与安全底座的在位断言' },
  { slug: 'kernel-state', glob: 'packages/kernel/src/state/**', why: 'seq 分配、状态归约与污点传播' },
  { slug: 'kernel-port', glob: 'packages/kernel/src/port/**', why: '端口契约——改了它，适配器那一侧的约束就没有对照物' },
  { slug: 'kernel-tool-registry', glob: 'packages/kernel/src/tool/registry.ts', why: '工具注册、可用性与 MCP 污点闸门' },
  { slug: 'kernel-tool-types', glob: 'packages/kernel/src/tool/types.ts', why: '工具能力与执行上下文契约' },
  { slug: 'contracts-permission', glob: 'packages/contracts/src/permission/**', why: '能力闭集与策略契约——删一个词条即让相关规则全部失效' },
  { slug: 'contracts-event', glob: 'packages/contracts/src/event/**', why: '事件信封与持久/瞬态分层——"模型可见 ⟺ 已落库"靠它成立' },
  { slug: 'contracts-secret', glob: 'packages/contracts/src/config/secret.ts', why: '密钥引用契约' },
  { slug: 'contracts-redact', glob: 'packages/contracts/src/base/redact.ts', why: '日志与审计的统一脱敏出口' },

  // ── 判定与执行之间的那条链（M3 之后不再只是 turn.ts）──
  { slug: 'runtime-turn', glob: 'packages/runtime/src/turn*.ts', why: '工具十二步链：判权、还原点与执行的统一入口' },
  { slug: 'runtime-session', glob: 'packages/runtime/src/session-runtime.ts', why: '全系统唯一的 seq 分配点与落库顺序' },
  { slug: 'runtime-invariant', glob: 'packages/runtime/src/invariant*.ts', why: '运行时不变量注册表与它的装配' },
  { slug: 'runtime-subagent', glob: 'packages/runtime/src/subagent.ts', why: '子 Agent 的工具集裁剪与污点回传' },
  { slug: 'tool-runtime', glob: 'packages/tool-runtime/src/**', why: '路径/命令/主机能力网关、写前还原点与 local 执行世界' },
  { slug: 'code-runtime', glob: 'packages/code-runtime/src/**', why: 'Code Mode 的客体域隔离与预算' },
  { slug: 'compose', glob: 'packages/compose/src/**', why: 'profile 装配、基线行不可替换断言' },

  // ── 适配器里握着真东西的那几处 ──
  { slug: 'platform-config', glob: 'packages/platform/src/config.ts', why: '用户配置加载与权限规则分层' },
  { slug: 'platform-paths', glob: 'packages/platform/src/paths.ts', why: '红线锚点与数据目录的解析' },
  { slug: 'platform-secret-file', glob: 'packages/platform/src/secret-file.ts', why: '密钥加密文件后端' },
  { slug: 'storage-event-store', glob: 'packages/storage/src/sqlite-event-store.ts', why: '事件库的并发写检测与写租约' },
  { slug: 'storage-schema', glob: 'packages/storage/src/schema.ts', why: '库结构与版本闸门' },
  { slug: 'desktop-main', glob: 'apps/desktop/src/main/**', why: '唯一同时认识 Electron 与业务的装配面（含系统钥匙串与 IPC 边界）' },
  { slug: 'desktop-preload', glob: 'apps/desktop/src/preload/**', why: 'contextIsolation 唯一的缺口' },

  // ── 护栏本身 ──
  { slug: 'scripts', glob: 'scripts/**', why: '工具链、密钥扫描与红线锚点等提交前护栏' },
  { slug: 'depcruise', glob: '.dependency-cruiser.cjs', why: '架构依赖护栏' },
  { slug: 'eslint', glob: 'eslint.config.js', why: '静态检查护栏' },
  { slug: 'githooks', glob: '.githooks/**', why: '提交前钩子' },
  { slug: 'workflows', glob: '.github/workflows/**', why: 'CI 流水线——改了它，上面所有护栏都可以不跑' },
  { slug: 'root-package', glob: 'package.json', why: '`pnpm verify` 的定义本身' },
  { slug: 'workspace-manifest', glob: 'pnpm-workspace.yaml', why: '依赖安装脚本的白名单（allowBuilds）' },
];

/**
 * 每条受保护路径要挂的能力。
 *
 * ⚠️ **只挂 `self.modify` 是不够的，而且不够的方式很具体。** M0-b 复审实测：
 *
 * ```
 * self.modify 改 <root>/packages/kernel/src/policy/defaults.ts → DENY [red.self-modify.*]
 * fs.write    改同一个文件                                      → 无规则匹配 → ALLOW
 * ```
 *
 * 能力是**工具自己声明**的。一个通用写文件工具声明的是 `fs.write`，它压根不知道
 * 自己正在改判定逻辑——于是整族自改红线被一个最普通的工具绕过。
 * **红线要按"目标是什么"来写，不能按"调用方自称在做什么"来写。**
 */
const GUARDED_CAPABILITIES = [
  { capability: 'self.modify' as const, suffix: '', verb: '修改' },
  { capability: 'fs.write' as const, suffix: '-fs-write', verb: '写入' },
  { capability: 'fs.delete' as const, suffix: '-fs-delete', verb: '删除' },
];

const joinRoot = (root: string, glob: string): string => `${root === '/' ? '' : root}/${glob}`;

/**
 * 生成自改红线。
 *
 * `sourceRoot` 与每棵 `extraSourceRoots` 各按清单展开一族；`installRoot` 是整棵树一族。
 * ID 里带树的标记（`app` / `w0` / `install`），一次装配里不会重名——
 * 重名的两条规则在审计里没法区分是哪棵树拦下的。
 */
export function selfModifyRedLines(roots: SelfCodeRoots): PolicyRule[] {
  const source = normalizedOrThrow(roots.sourceRoot);
  const extras = (roots.extraSourceRoots ?? [])
    .map((root) => normalizedOrThrow(root))
    // 开发模式下"正在运行的这棵"与"会话工作区那棵"经常是同一棵，去重免得规则翻倍
    .filter((root, index, all) => root !== source && all.indexOf(root) === index);

  const rules: PolicyRule[] = [
    ...treeRules(source, 'app'),
    ...extras.flatMap((root, index) => treeRules(root, `w${String(index)}`)),
  ];

  if (roots.installRoot !== undefined) {
    const install = normalizedOrThrow(roots.installRoot);
    rules.push(
      ...GUARDED_CAPABILITIES.map(({ capability, suffix, verb }) => ({
        id: `red.self-install${suffix}`,
        effect: 'deny' as const,
        capability,
        match: { target: joinRoot(install, '**') },
        reason:
          `${verb}小明自己的安装目录。这里放着可执行文件、原生模块与 app.asar，` +
          `改掉其中任何一样，源码里那份受保护清单就全都不作数了（docs/07 §5）。只能由人手工进行。`,
        immutable: true,
      })),
    );
  }

  assertUniqueIds(rules);
  return rules;
}

function treeRules(root: string, tag: string): PolicyRule[] {
  return SELF_MODIFY_PROTECTED.flatMap((protectedPath) =>
    GUARDED_CAPABILITIES.map(({ capability, suffix, verb }) => ({
      id: `red.self-modify.${tag}.${protectedPath.slug}${suffix}`,
      effect: 'deny' as const,
      capability,
      match: { target: joinRoot(root, protectedPath.glob) },
      reason:
        `${verb}${protectedPath.why}。这类文件改掉之后，后续改动就没有任何东西拦得住了` +
        `（docs/07 §5）。只能由人手工进行。`,
      immutable: true,
    })),
  );
}

/** ID 撞车 = 审计里分不清是哪条规则拦的。构造期就炸，别等到查事故时才发现 */
function assertUniqueIds(rules: readonly PolicyRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(
        `自改红线的规则 ID "${rule.id}" 重复。ID 进审计事件流，重复就意味着` +
          `事后查不出是哪条规则拦下的——检查 SELF_MODIFY_PROTECTED 的 slug 与代码树的 tag。`,
      );
    }
    seen.add(rule.id);
  }
}
