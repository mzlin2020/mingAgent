#!/usr/bin/env node
/**
 * 桌面端两份 tsconfig 的 `paths` 映射完整性闸门。
 *
 * 由来（2026-08-06，M1-c 推上去之后 CI 的 lint job 直接红）：
 *
 *   apps/desktop/src/main/services.ts
 *     124:19  error  Unsafe call of a type that could not be resolved
 *     …8 条
 *
 * 原因不是代码，是**装配**：`tsconfig.main.json` 把 `@xm/*` 逐个映射到各包的
 * `src/index.ts`，而新加的 `@xm/tools-core` 忘了加一行。少了那一行，类型解析就退回
 * 包自己的 `main`/`types`，也就是 `dist/index.d.ts`——
 *
 *   · 本地：`dist` 早就 build 出来了，一切正常；
 *   · `desktop` / `test` job：跑之前都有 `tsc -b`，也正常；
 *   · `lint` job：**只 install，不 build**。干净检出上没有 dist，
 *     于是那个 import 的类型变成 error type，`no-unsafe-*` 一片红。
 *
 * 也就是说，这个洞只在"没有构建产物的干净检出"上才看得见——而那恰好是
 * 六个 job 里唯一那么干的一个。本地 `pnpm verify` 永远绿。
 *
 * 所以这里检两件事，都是**静态**的、不需要构建：
 *   一、源码里 import 到的每个 `@xm/*`，在对应 tsconfig 的 `paths` 里都有映射；
 *   二、每条映射指向的文件真的存在（防手滑写错路径——那同样会静默退回 dist）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const TSCONFIGS = ['apps/desktop/tsconfig.main.json', 'apps/desktop/tsconfig.renderer.json'];

const problems = [];

/** tsconfig 允许注释，JSON.parse 不允许。只需要够用：行注释与块注释 */
const stripComments = (text) =>
  text.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
    m.startsWith('"') ? m : '',
  );

function sourceFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

for (const file of TSCONFIGS) {
  const root = dirname(file);
  const config = JSON.parse(stripComments(readFileSync(file, 'utf8')));
  const paths = config.compilerOptions?.paths ?? {};

  // 二、映射指向的文件必须存在
  for (const [spec, targets] of Object.entries(paths)) {
    for (const target of targets) {
      if (!existsSync(resolve(root, target))) {
        problems.push(`${file} 的 "${spec}" 指向 ${target}，而那个文件不存在。`);
      }
    }
  }

  // 一、import 到的每个 @xm/* 都要有映射
  //     include 里的 glob 取通配之前的那一段当目录，够用且不必引 glob 库
  const dirs = (config.include ?? []).map((g) => resolve(root, g.split('*')[0]));
  for (const source of new Set(dirs.flatMap(sourceFiles))) {
    const text = readFileSync(source, 'utf8');
    for (const [, spec] of text.matchAll(/from\s+'(@xm\/[^']+)'/g)) {
      if (!(spec in paths)) {
        problems.push(
          `${source} 里 import 了 ${spec}，而 ${file} 的 paths 里没有它。\n` +
            `    后果：类型解析退回该包的 dist/*.d.ts —— 本地有构建产物时看不出来，` +
            `CI 的 lint job（只 install 不 build）会一片 no-unsafe-*。`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\n✗ tsconfig 的 paths 映射不完整：\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}

console.log(`✓ tsconfig paths 完整：${TSCONFIGS.join('、')}`);
