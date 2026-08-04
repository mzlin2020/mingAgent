#!/usr/bin/env node
/**
 * 双编译器工具链装配断言（ADR-0010）
 *
 * 我们同时装了两个 TypeScript：
 *   - `@typescript/native`  = npm:typescript@7.x   → 提供 `tsc` 二进制，负责一切编译
 *   - `typescript`          = npm:@typescript/typescript6@6.x → 提供 JS 编译器 API，
 *                                                      供 typescript-eslint 等工具使用
 *
 * 两个包都声明了名为 `tsc` 的 bin。实测 pnpm 会把 node_modules/.bin/tsc 链到
 * @typescript/native（我们要的结果），但这依赖解析顺序，不是契约。
 *
 * 一旦 `tsc` 悄悄变成 TS 6，我们就会开始依赖 TS 6 的产物行为，将来 7.1 出来
 * 想去掉 TS 6 时的"零成本迁移"就不成立了。本脚本是这条纪律唯一的自动化执行点。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const EXPECT_COMPILER_MAJOR = '7';
const EXPECT_API_MAJOR = '6';

/** 用与 npm scripts 相同的方式解析 `tsc`，确保测的是构建实际会用到的那一个 */
function compilerVersion() {
  const isWin = process.platform === 'win32';
  const out = execFileSync(isWin ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsc', '--version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 形如 "Version 7.0.2"
  const m = /(\d+)\.(\d+)\.\d+/.exec(out);
  if (!m) throw new Error(`无法解析 tsc --version 的输出：${JSON.stringify(out)}`);
  return { full: m[0], major: m[1] };
}

/** typescript-eslint 等工具走 require('typescript')，必须落到 TS 6 的 JS 实现上 */
function apiVersion() {
  const pkg = require('typescript/package.json');
  const api = require('typescript');
  return {
    full: pkg.version,
    major: pkg.version.split('.')[0],
    hasCompilerApi: typeof api.createProgram === 'function',
  };
}

const problems = [];

let compiler;
try {
  compiler = compilerVersion();
  if (compiler.major !== EXPECT_COMPILER_MAJOR) {
    problems.push(
      `\`tsc\` 解析到了 TS ${compiler.full}，期望 ${EXPECT_COMPILER_MAJOR}.x。\n` +
        `    编译必须走 @typescript/native（原生二进制）。检查 devDependencies 的别名是否被改动，\n` +
        `    或先跑 \`pnpm install\` 重建 node_modules/.bin。`,
    );
  }
} catch (err) {
  problems.push(`无法执行 \`pnpm exec tsc --version\`：${err.message}`);
}

let api;
try {
  api = apiVersion();
  if (api.major !== EXPECT_API_MAJOR) {
    problems.push(
      `\`require('typescript')\` 解析到 ${api.full}，期望 ${EXPECT_API_MAJOR}.x。\n` +
        `    typescript-eslint 需要 JS 编译器 API，而 TS 7.0 完全不提供（见 ADR-0010）。`,
    );
  }
  if (!api.hasCompilerApi) {
    problems.push(
      `\`require('typescript')\` 没有 createProgram —— 这正是 TS 7.0 的特征。\n` +
        `    typed lint 会硬失败。devDependencies 里 typescript 必须别名到 @typescript/typescript6。`,
    );
  }
} catch (err) {
  problems.push(`无法 require('typescript')：${err.message}`);
}

if (problems.length > 0) {
  console.error('\n✗ 工具链装配不正确（ADR-0010）：\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  console.error('  期望形态：');
  console.error('    "@typescript/native": "npm:typescript@^7.0.2"      → tsc 二进制');
  console.error('    "typescript":         "npm:@typescript/typescript6@^6.0.2"  → JS API\n');
  process.exit(1);
}

console.log(
  `✓ 工具链正确：编译 tsc ${compiler.full}（原生）｜ API require('typescript') ${api.full}（JS）`,
);
