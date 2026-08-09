#!/usr/bin/env node
/**
 * 单文件规模纪律闸门（ADR-0032 #3，落实 docs/01 原则七的可检验约束）。
 *
 * 原则七写的是"单文件超过 400 行、单函数超过 60 行触发审查"——但从 M0 起就没有
 * 配一个自动化检查，纯靠自觉。地基复审三（ADR-0032）实测抓到 `App.tsx` 长到
 * 1023 行（2.6 倍）都没人拦。docs/01 自己的元规则是"不能被 CI 或代码审查检验
 * 的原则等于没有"——这条脚本把"文件行数"这一半先接上 CI。
 *
 * ── 只查文件行数，不查函数行数 ──
 *
 * 函数级检查需要真正解析 AST（区分函数边界、跳过类型声明/接口），而文件行数
 * 用行计数就够。这是刻意缩小的范围，不是忘了——本轮复审也没有发现"单个函数
 * 离谱地长"的证据，函数级检查留给以后真的出现这类问题时再补，不提前做没有
 * 证据支撑的工程。
 *
 * ── 只查 `src/`，不查 `tests/` ──
 *
 * 测试文件天然会随着用例数量增长（`gateway.test.ts`/`adapters.test.ts`/
 * `policy-engine.test.ts` 现在都超过 400 行），但那不是"职责混在一起该拆"的
 * 信号——独立的 `it()` 块本来就适合堆在同一个文件里按主题分组，拆开反而更难
 * 找。原则七的"触发审查"针对的是生产代码里职责该拆而没拆的信号，测试文件
 * 不是这条规则真正要防的东西。
 *
 * ── 允许显式豁免（同 depcruise 豁免的先例）──
 *
 * 豁免必须写在下面的 `ALLOWLIST` 里并附一句理由——不允许行内 `eslint-disable`
 * 式的、传染性的豁免。豁免的文件如果哪天瘦回 400 行以内，这里会报错提醒摘掉，
 * 防止豁免清单只增不减、变成一份没人再检查是否还有效的名单。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath 而不是 `.pathname`：后者在 Windows 上产出 `/D:/a/...` 这种带
// 前导斜杠的 URL 路径，不是合法的文件系统路径，`readdirSync`/`readFileSync`
// 在 Windows CI 上会直接 ENOENT（同一个坑在 evals/regression/schema.test.ts
// 里已经实测炸过一次）。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_LINES = 400;

const SCAN_DIRS = ['packages', 'apps/desktop/src'];
const EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDE_SEGMENTS = ['dist', 'node_modules', 'tests', 'release'];

/**
 * 已知超限、且本轮复审判断"暂时不拆"的文件（ADR-0032 #2 的范围之外）。
 * 每条都要写清楚为什么现在不拆——"以后再说"不是理由，"现在拆的收益低于风险"才是。
 */
const ALLOWLIST = {
  'packages/kernel/src/policy/defaults.ts':
    '内容是一份平铺的默认规则列表（BALANCED_DEFAULT_RULES 等），行数来自条目数量' +
    '而不是职责混杂——按能力拆成多个文件需要先想清楚"规则的分组边界"，属于独立的' +
    '设计工作，不是简单的物理搬运，本轮不顺手做。',
  'apps/desktop/src/main/services.ts':
    '整个应用唯一知道 Electron 与业务同时存在的装配文件（文件顶部注释原话）——' +
    '本质是一处，拆开多个文件反而会把"这里才是唯一装配点"这条不变量拆得不再一目了然。',
  'packages/kernel/src/policy/engine.ts':
    '核心判定函数 evaluate() 所在文件，超限比例低（1.05x），且是本项目里被审查最多、' +
    '测试覆盖最密的文件之一——现在拆分的改动风险高于"稍微超限"本身的成本。',
  'packages/kernel/src/policy/command-claims.ts':
    'analyzeArgv() 的主张分解逻辑，超限比例低（1.01x），拆分需要先理清楚词法器/' +
    '主张构造两部分的边界，不是本轮复审的范围。',
  /*
   * 以下 5 条是这个脚本第一次跑起来时才发现的——ADR-0032 手工审查时用 `wc -l` +
   * 一条 shell glob 扫的，那条 glob 漏掉了这几个文件（`**` 在部分 shell 下不递归
   * 展开），是"审查过程本身不可靠、必须自动化"这条道理的现场教材。如实记下来，
   * 不因为是自动查出来的、没写进 ADR 原文就假装没看见。
   */
  'packages/runtime/src/turn.ts':
    '1012 行，2.53 倍——五条里最严重的一个。它是主循环的调度核心（dispatchCall/' +
    'executeCall/权限判定串联），拆分需要非常谨慎地划清边界且要有人在场逐条验证行为' +
    '不变，风险显著高于本轮其余的纯搬运式重构（App.tsx 那种）。**如实记录为遗留项，' +
    '不在无人值守的这一轮动它**——留给后续专门排一次有人审阅的重构。',
  'packages/tools-core/src/gateway.ts':
    '494 行——路径/命令/主机三个 target 解析分支所在文件，是权限判定链路上安全敏感' +
    '的一环。拆分本身不难，但"改动安全判定代码"按项目一贯原则需要更高等级的审慎与' +
    '复核，本轮不做无人值守的改动。',
  'packages/storage/src/sqlite-event-store.ts':
    '521 行（本轮 ADR-0032 #1 加快照表/方法后从更早的数字涨上来的）——排他标记与' +
    '事务语义的正确性依赖当前的代码组织方式被反复验证过（见文件内大段注释记录的' +
    '真实缺陷史），拆分前需要为拆分本身设计一遍测试策略，不是本轮的范围。',
  'packages/providers/src/anthropic.ts':
    '473 行——SSE 流解析与 Provider 适配器实现，涉及计费与断线重连等细节行为，' +
    '同样属于"需要人复核而非无人值守重构"的一类，本轮不动。',
  'packages/tools-core/src/pty-session.ts':
    '426 行，超限比例很低（1.06x）——PTY 会话管理与四个工具定义放在同一文件是' +
    'ADR-0031 的既定组织方式（manager + 工具 + 类型定义同源方便对照），拆分收益不明显。',
};

/** @returns {string[]} 相对仓库根目录的路径列表 */
function walk(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (EXCLUDE_SEGMENTS.includes(entry.name)) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else if (EXTENSIONS.has(extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).map((abs) => ({
  abs,
  rel: relative(ROOT, abs).split('\\').join('/'),
}));

const overLimit = [];
const staleAllowlist = [];

for (const { abs, rel } of files) {
  const lines = readFileSync(abs, 'utf8').split('\n').length;
  const exempt = ALLOWLIST[rel];

  if (lines > MAX_LINES && exempt === undefined) {
    overLimit.push(`${rel}：${String(lines)} 行（超出 ${MAX_LINES} 行这条线 ${(lines / MAX_LINES).toFixed(2)} 倍）`);
  } else if (lines <= MAX_LINES && exempt !== undefined) {
    staleAllowlist.push(`${rel}：现在只有 ${String(lines)} 行，已经回到线内，请把它从 ALLOWLIST 里删掉`);
  }
}

// 豁免清单里出现了不存在的路径 —— 大概率是文件被移动/重命名了，清单没跟着改
const existing = new Set(files.map((f) => f.rel));
const danglingAllowlist = Object.keys(ALLOWLIST).filter((p) => !existing.has(p));

const problems = [...overLimit, ...staleAllowlist, ...danglingAllowlist.map((p) => `${p}：豁免清单里的路径已经不存在`)];

if (problems.length > 0) {
  console.error(`\n✗ 单文件规模纪律（docs/01 原则七，ADR-0032）不满足：\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error(
    `\n超过 ${String(MAX_LINES)} 行的生产代码文件要么拆分，要么在 ` +
      `scripts/check-file-size.mjs 的 ALLOWLIST 里显式登记理由。\n`,
  );
  process.exit(1);
}

console.log(`✓ 单文件规模纪律：扫描 ${String(files.length)} 个文件，均在 ${String(MAX_LINES)} 行线内或已登记豁免`);
