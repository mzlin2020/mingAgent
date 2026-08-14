import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
const windows = process.platform === 'win32';
const tsc = join(root, 'node_modules', '.bin', windows ? 'tsc.CMD' : 'tsc');
const hasBuiltinTools = existsSync(join(root, 'packages', 'tools-core', 'tsconfig.json'));
const run = (args) => execFileSync(tsc, args, {
  cwd: root,
  stdio: 'inherit',
  ...(windows ? { shell: true } : {}),
});

run(['-b', hasBuiltinTools ? 'tsconfig.json' : 'tsconfig.no-tools.json']);
if (hasBuiltinTools) run(['-p', 'tsconfig.tests.json']);
run(['-p', 'apps/desktop/tsconfig.main.json']);
run(['-p', 'apps/desktop/tsconfig.renderer.json']);

if (!hasBuiltinTools) {
  console.log('✓ typecheck：tools-core 物理缺席，核心、运行时与桌面 UI 仍可编译');
}
