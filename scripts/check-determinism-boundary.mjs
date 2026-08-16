#!/usr/bin/env node
/**
 * ADR-0066 的过渡护栏。
 *
 * M3-b 已把 runtime 与 kernel 的时间/ID 输入迁到 ctx.clock / ctx.ids。这里持续扫描两层，
 * 任何新的环境直调都直接失败；过渡清单已经归零。
 *
 * **先去注释再扫**（M3-h 补）。不去的话，一句"客体域里 `Date.now()` 的取值来自 ctx.clock"
 * 这样的说明文字会被算成一次直调——而这条闸门要拦的恰恰是代码。让人为了过闸门
 * 去改注释措辞，最后一定会有人反过来把闸门放宽，那才是真正的损失。
 * 与 `check-invariants.mjs` 用的是同一招，理由也一样。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['packages/kernel/src', 'packages/runtime/src'];
const ID_PATTERN = /\bnew(?:Session|Event|Turn|Message|Call|Request|Agent|Checkpoint|EditProposal|PtySession)Id\(/g;
const DATE_PATTERN = /\bDate\.now\(/g;

const ALLOWLIST = new Map();

/** 粗暴但够用的去注释：判据只看代码 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (statSync(path).isFile() && extname(path) === '.ts') out.push(path);
  }
  return out;
}

const actual = new Map();
for (const dir of SCAN_DIRS) {
  for (const path of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, path).split('\\').join('/');
    const text = stripComments(readFileSync(path, 'utf8'));
    const dates = [...text.matchAll(DATE_PATTERN)].length;
    const ids = [...text.matchAll(ID_PATTERN)].length;
    if (dates > 0) actual.set(`${rel}|Date.now`, dates);
    if (ids > 0) actual.set(`${rel}|newId`, ids);
  }
}

const problems = [];
for (const [key, count] of actual) {
  const allowed = ALLOWLIST.get(key) ?? 0;
  if (count !== allowed) problems.push(`${key}：实际 ${String(count)}，过渡清单 ${String(allowed)}`);
}
for (const [key, allowed] of ALLOWLIST) {
  if (!actual.has(key)) problems.push(`${key}：既有调用已清零，请删除过渡清单中的 ${String(allowed)}`);
}

if (problems.length > 0) {
  console.error('\n✗ 确定性边界漂移（ADR-0066）：\n');
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error('\n新增时间/ID 必须走 ctx.clock / ctx.ids；减少既有债务时同步收紧本脚本。\n');
  process.exit(1);
}

console.log('✓ 确定性边界：runtime/kernel 的时间与 ID 环境直调为零');
