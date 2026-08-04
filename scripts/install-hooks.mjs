#!/usr/bin/env node
/**
 * 把 git hooks 目录指到仓库内的 .githooks/，这样钩子随代码走、可审查、可版本化。
 * 刻意不引入 husky —— 一个 `git config` 就够了，少一个依赖少一个供应链面。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(root, '.githooks');

if (!existsSync(join(root, '.git'))) {
  console.log('· 不是 git 仓库，跳过钩子安装');
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  // Windows 上 chmod 是空操作，忽略即可
  for (const f of readdirSync(hooksDir)) {
    try {
      chmodSync(join(hooksDir, f), 0o755);
    } catch {
      /* Windows */
    }
  }
  console.log('✓ git hooks 已指向 .githooks/（含提交前密钥扫描）');
} catch (err) {
  console.warn(`! git hooks 安装失败，提交前密钥扫描不会生效：${err.message}`);
}
