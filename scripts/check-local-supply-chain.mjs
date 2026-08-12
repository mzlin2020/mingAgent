import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fail = (message) => { throw new Error(`本地供应链检查失败：${message}`); };
const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8').catch(() => fail('缺少 pnpm-lock.yaml'));
if (!/^lockfileVersion:/m.test(lock) || !/integrity:/m.test(lock)) fail('锁文件缺少版本或完整性记录');

const ignored = new Set(['.git', 'node_modules', 'dist', 'release', 'coverage', '.turbo']);
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(root);

for (const path of files.filter((file) => file.endsWith('package.json'))) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[group] ?? {})) {
      if (/^(?:git(?:\+|:)|github:|https?:\/\/)/i.test(String(spec))) {
        fail(`${relative(root, path)} 的 ${name} 使用了网络/Git 依赖地址`);
      }
    }
  }
}

const workspace = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
const allowedBuilds = [...workspace.matchAll(/^\s{2}([@\w./-]+):\s*true\s*$/gm)].map((match) => match[1]).sort();
const expectedBuilds = ['better-sqlite3', 'electron', 'esbuild', 'node-pty'].sort();
if (JSON.stringify(allowedBuilds) !== JSON.stringify(expectedBuilds)) {
  fail(`安装脚本白名单已变更：${allowedBuilds.join(', ')}`);
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
];
for (const path of files) {
  if (/\.(?:png|jpe?g|gif|ico|woff2?|sqlite|db)$/i.test(path)) continue;
  const text = (await readFile(path, 'utf8').catch(() => ''))
    .split(/\r?\n/)
    .filter((line) => !line.includes('xm-secret-scan:allow'))
    .join('\n');
  if (secretPatterns.some((pattern) => pattern.test(text))) fail(`发现高置信密钥特征：${path}`);
}
console.log(`✓ 本地供应链检查通过：锁文件、依赖来源、安装脚本白名单、密钥特征`);
