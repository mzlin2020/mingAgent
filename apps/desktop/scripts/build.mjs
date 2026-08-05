/**
 * 构建三段产物：renderer（Vite）、main + preload（tsup）。
 *
 * 刻意用一个脚本串起来而不是 `npm-run-all`：多一个依赖换一行简洁不划算，
 * 而且这里要在最后做一次**产物存在性检查**——三段里少一段的表现是应用起来白屏，
 * 而白屏在 CI 里是看不见的。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = fileURLToPath(new URL('..', import.meta.url));

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('pnpm', ['exec', 'vite', 'build']);
run('pnpm', ['exec', 'tsup']);

const required = [
  'dist/renderer/index.html',
  'dist/main/index.js',
  // 必须是 .cjs：sandbox 下的 preload 只能是 CJS，而 type:module 下 .js 会被当 ESM
  'dist/preload/index.cjs',
];

const missing = required.filter((p) => !existsSync(new URL(p, new URL('..', import.meta.url))));
if (missing.length > 0) {
  console.error(`✗ 构建产物缺失：${missing.join('、')}`);
  process.exit(1);
}
console.log('✓ 桌面产物齐全：renderer / main / preload');
