#!/usr/bin/env node
/**
 * 自改红线的**指向闸门**（ADR-0078）。
 *
 * 它只回答一个问题：`SELF_MODIFY_PROTECTED` 里的每条 glob，今天还指着东西吗？
 *
 * ── 为什么需要这么一道看起来多余的检查 ──
 *
 * 地基复审四 A2：M3 把网关搬进 `tool-runtime`、把十二步链拆出 `turn.ts`、
 * 把装配改名成 `desktop-host.ts`。三条受保护路径因此指向已经不存在的文件，
 * 而**每一道既有护栏都是绿的**——depcruise 查的是包与包的依赖，typecheck 查的是类型，
 * 1412 条用例查的是行为。没有任何一道查"规则里那个字符串还指不指得着代码"。
 * 于是一条红线可以在一次纯粹的重命名之后安静地保护一个空目标，谁也不会知道。
 *
 * 本仓库栽在"规则存在但从未生效"上已经九次。这道闸门补的是其中一类：
 * **任何用字符串常量指认代码位置的规则，都必须有东西证明那个字符串今天还指着代码。**
 *
 * ── 为什么用内核自己的 `globMatch` ──
 *
 * 不自己写一个匹配器：这里若用 Node 的 glob 或一段手写正则，就会出现
 * "闸门认为匹配、判定引擎认为不匹配"的分叉，而那种分叉的表现正是它要防的东西
 * （闸门绿着、红线空着）。用同一个函数，才叫"验证了那条规则会命中"。
 *
 * ── 反向演练 ──
 *
 * `packages/kernel/tests/self-code-gate.test.ts` 拿一份合成的文件清单跑
 * `findStaleTargets()`：删掉一个被保护的文件，它必须红。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_MODIFY_PROTECTED, globMatch } from '../packages/kernel/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.git', 'release', 'coverage', '.turbo']);

/**
 * 哪些 glob 已经指不着任何东西。**纯函数**，好让反向演练不必真的动磁盘。
 *
 * @param {readonly {slug: string, glob: string, why: string}[]} protectedPaths
 * @param {readonly string[]} paths 仓库里所有文件与目录的相对路径（`/` 分隔）
 * @returns {readonly {slug: string, glob: string}[]}
 */
export function findStaleTargets(protectedPaths, paths) {
  return protectedPaths
    .filter((entry) => !paths.some((path) => globMatch(entry.glob, path, false, 'path')))
    .map((entry) => ({ slug: entry.slug, glob: entry.glob }));
}

/** 仓库里的全部文件与**目录**（`a/b/**` 这种模式要能被目录自身命中） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    out.push(relative(ROOT, abs).split('\\').join('/'));
    if (entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(abs))) walk(abs, out);
  }
  return out;
}

const safeIsDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/*
 * 直接跑才检查。**被 import 时不能自己跑**——`tests/self-code-gate.test.ts` 要拿
 * `findStaleTargets()` 做反向演练，而这段代码会 `process.exit(1)`：
 * 那会让整个测试进程当场消失，表现成"用例莫名其妙不见了"。
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();

function main() {
const paths = walk(ROOT);
const stale = findStaleTargets(SELF_MODIFY_PROTECTED, paths);

if (stale.length > 0) {
  console.error('✗ 自改红线指向了不存在的路径：\n');
  for (const entry of stale) {
    console.error(`  ${entry.slug.padEnd(24)} ${entry.glob}`);
  }
  console.error(
    '\n这些 glob 在仓库里匹配不到任何文件或目录，也就是说对应的红线永远不会命中。\n' +
      '通常是一次重命名/搬家造成的（M3 把网关搬进 tool-runtime 时就这么丢过三条）。\n' +
      '改 packages/kernel/src/policy/self-code.ts 里的 SELF_MODIFY_PROTECTED：\n' +
      '  · 文件搬走了 → 改成新路径；\n' +
      '  · 文件不该再被保护 → 删掉这一条，并在 ADR 里写清为什么它不再是"改了就没人拦得住"的那一类。\n',
  );
  process.exit(1);
}

console.log(`✓ 自改红线：${String(SELF_MODIFY_PROTECTED.length)} 条受保护路径全部指向真实文件`);
}
