/**
 * 开发模式：Vite dev server（渲染层热更新）+ tsup watch（main/preload）+ Electron。
 *
 * 渲染层走 http，主进程走 file——**两条路径的差异是真实的**：`base: './'` 写错
 * 只在打包产物里炸，dev 下永远看不出来。所以别把"dev 起得来"当成"能发布"。
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5273;
const children = [];

const start = (cmd, args, env = {}) => {
  const child = spawn(cmd, args, {
    cwd: here,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  return child;
};

const stopAll = () => {
  for (const c of children) c.kill();
};
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

// main / preload 先构建一次，再进 watch —— Electron 起来时产物必须已经在
const built = spawnSync('pnpm', ['exec', 'tsup'], {
  cwd: here,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (built.status !== 0) process.exit(built.status ?? 1);

start('pnpm', ['exec', 'vite']);
start('pnpm', ['exec', 'tsup', '--watch']);

await waitForPort(PORT);

const electron = start('pnpm', ['exec', 'electron', '.'], {
  XM_DEV_SERVER: `http://localhost:${String(PORT)}`,
});
electron.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});

async function waitForPort(port) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${String(port)}/`);
      if (res.ok) return;
    } catch {
      // dev server 还没起来
    }
    if (Date.now() > deadline) {
      console.error(`✗ Vite dev server 30 秒内没起来（端口 ${String(port)}）`);
      stopAll();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
