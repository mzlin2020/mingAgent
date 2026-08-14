#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROFILE_NAMES, builtinProfile } from '../packages/compose/dist/index.js';

const outputPath = fileURLToPath(new URL('../docs/generated/M3-b-接缝图.md', import.meta.url));
const cell = (values) => values.length === 0 ? '—' : values.map((value) => `\`${value}\``).join('<br>');

const lines = [
  '# M3-b profile 接缝图',
  '',
  '> 本文件由 `node scripts/generate-seam-map.mjs` 生成；请勿手工编辑。',
  '',
  '四个内建 profile 均经 `@xm/compose` 的同一条装配路径启动。`baseline.*` 是不可被用户 patch 替换、删除或插队的特权基线。',
  '',
  '| profile | 层级 | 行 ID | 插件引用 | 注入服务 | 提供服务 |',
  '|---|---|---|---|---|---|',
];

for (const name of BUILTIN_PROFILE_NAMES) {
  for (const row of builtinProfile(name).rows) {
    lines.push(
      `| \`${name}\` | ${row.id.startsWith('baseline.') ? '特权基线' : '业务'} | ` +
      `\`${row.id}\` | \`${row.plugin}\` | ${cell(row.inject)} | ${cell(row.provide)} |`,
    );
  }
}

lines.push(
  '',
  '## 固定边界',
  '',
  '- `desktop` 与 `headless` 使用本机 clock/ID provider；`test` 使用确定性 provider。',
  '- `gateway` 与 `checkpoint` 实现位于 `@xm/tool-runtime`；`@xm/tools-core` 只保留业务工具。',
  '- 用户 patch 只从显式的用户 `configDir/profiles/<name>.patch.json` 读取。',
  '- `--dump-config` 输出在写往 stdout 前统一经过脱敏。',
  '',
);

const expected = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch {
    // 统一走下面的过期提示。
  }
  if (actual !== expected) {
    console.error('M3-b 接缝图缺失或已过期；请运行 pnpm generate:seams。');
    process.exit(1);
  }
  console.log('✓ M3-b 接缝图与内建 profile 一致。');
} else {
  writeFileSync(outputPath, expected, 'utf8');
  console.log(`✓ 已生成 ${outputPath}`);
}
