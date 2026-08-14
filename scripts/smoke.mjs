import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
const windows = process.platform === 'win32';
const tsc = join(root, 'node_modules', '.bin', windows ? 'tsc.CMD' : 'tsc');
const hasBuiltinTools = existsSync(join(root, 'packages', 'tools-core', 'tsconfig.json'));
const node = (file, args = []) => execFileSync(process.execPath, [file, ...args], {
  cwd: root,
  stdio: 'inherit',
});

execFileSync(tsc, ['-b', hasBuiltinTools ? 'tsconfig.json' : 'tsconfig.no-tools.json'], {
  cwd: root,
  stdio: 'inherit',
  ...(windows ? { shell: true } : {}),
});
node(join(root, 'scripts', hasBuiltinTools ? 'smoke-headless.mjs' : 'smoke-headless-no-tools.mjs'));
node(join(root, 'scripts', 'smoke-write-lease-recovery.mjs'));
