#!/usr/bin/env node
/**
 * ADR-0073 的护栏：三层 token 只有第二层能被组件看见。
 *
 * 四项检查，每一项都对应一个**真实发生过或必然发生**的失效：
 *
 * 一、组件里不许出现字面色值。清零命名空间挡住了 `bg-red-500`，但挡不住 `bg-[#fff]`——
 *     后者照样编译得出来，而且换主题时它不会跟着变。
 * 二、组件里不许引用调色板层（`--p-*`）。第一层没有语义，直接用等于把"这里为什么是这个色"
 *     的答案埋进组件；换调性时找不回来。
 * 三、组件里不许写 Tailwind 自带调色板的族名（`text-white` / `bg-gray-100` …）。
 *     命名空间清零之后它们**不报错，只是什么也不生成**——一次静默失效，
 *     肉眼看是"这行样式没生效"，很难联想到是被清零了。
 * 四、`lib/cn.ts` 的档位表必须与 `@theme` 一一对应；两处深色定义必须逐字节一致，
 *     且跟随系统那份的选择器必须带 `:not([data-theme='light'])`。
 *
 * 第四项里的前半条是在补一个**旧洞**：`cn.ts` 顶部写着"这张表必须和 `styles.css` 的
 * `@theme` 一一对应——加 token 时两处一起改"。那是一句靠自觉的约定，
 * 而本仓库栽过八次的正是这个形状（规则写下了，但没有任何东西检验它）。
 * 后半条同理：深色写两份是 CSS 没有 mixin 的无奈，靠"记得同步"必然漂。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RENDERER = 'apps/desktop/src/renderer';
const STYLES = join(ROOT, RENDERER, 'styles.css');
const CN = join(ROOT, RENDERER, 'lib/cn.ts');

/** 字面色值。`#` 后面必须是 3/4/6/8 位十六进制且到词尾，避免误伤 `#root` 这类选择器字符串 */
const LITERAL_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?|oklch|color-mix)\s*\(/g;
const PALETTE_REF = /--p-[a-z]/g;
/** Tailwind 自带调色板的族名，只在工具类前缀之后才算——`border-border` 不该被误伤 */
const TAILWIND_PALETTE =
  /\b(?:bg|text|border|from|via|to|ring|outline|fill|stroke|divide|decoration|shadow|accent|caret|placeholder)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/g;

/**
 * 豁免。**每条必须写清为什么它不是配色选择**，否则这张表迟早变成绕过闸门的正门。
 */
const ALLOWLIST = new Map([
  [
    'apps/desktop/src/renderer/components/terminal-panel.tsx|字面色值',
    '`#00000000` 传给 xterm 的 theme.background，表示“全透明”而不是一个颜色；底色由外层 `bg-terminal-bg` 提供。xterm 只接受字符串，写 token 名它认不得',
  ],
]);

/** 粗暴但够用的去注释：判据只看代码。与 check-determinism-boundary.mjs 同一招，理由也一样 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (statSync(path).isFile() && ['.ts', '.tsx'].includes(extname(path))) out.push(path);
  }
  return out;
}

const problems = [];

// ── 一 / 二 / 三：扫组件 ──
for (const path of walk(join(ROOT, RENDERER))) {
  const rel = relative(ROOT, path).split('\\').join('/');
  const text = stripComments(readFileSync(path, 'utf8'));
  const hits = [
    ['字面色值', [...text.matchAll(LITERAL_COLOR)].map((m) => m[0])],
    ['调色板层', [...text.matchAll(PALETTE_REF)].map((m) => m[0])],
    ['Tailwind 自带色', [...text.matchAll(TAILWIND_PALETTE)].map((m) => m[0])],
  ];
  for (const [kind, found] of hits) {
    if (found.length === 0) continue;
    if (ALLOWLIST.has(`${rel}|${kind}`)) continue;
    problems.push(`${rel}：出现${kind} ${[...new Set(found)].join('、')}`);
  }
}

for (const key of ALLOWLIST.keys()) {
  const [rel, kind] = key.split('|');
  const path = join(ROOT, rel);
  let text;
  try {
    text = stripComments(readFileSync(path, 'utf8'));
  } catch {
    problems.push(`${key}：豁免指向的文件已不存在，请删除该条豁免`);
    continue;
  }
  const pattern = kind === '字面色值' ? LITERAL_COLOR : kind === '调色板层' ? PALETTE_REF : TAILWIND_PALETTE;
  if ([...text.matchAll(pattern)].length === 0) {
    problems.push(`${key}：已经不再出现，请删除该条豁免`);
  }
}

// ── 四：styles.css 与 cn.ts ──
const css = readFileSync(STYLES, 'utf8');

/**
 * 取 `@theme { … }` 的内容。两处讲究：
 * 花括号在本文件里有嵌套（`@keyframes`），所以数括号而不是贪婪匹配；
 * 起点只认**行首**的 `@theme`——文件头的说明注释里也写着 `@theme`，
 * 按 `indexOf` 找会从那句注释开始数括号，然后一路错到底（写这段时就撞了一次）。
 */
function themeBlock(source) {
  const start = source.search(/^@theme\s*\{/m);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', start) + 1, i);
    }
  }
  return undefined;
}

const theme = themeBlock(css);
if (theme === undefined) {
  problems.push(`${RENDERER}/styles.css：找不到 @theme 块`);
} else {
  /** `@theme` 里登记的档位，按命名空间归类。`--text-x--line-height` 是 x 的附属，不单算一档 */
  const declared = { color: [], radius: [], text: [], shadow: [], font: [], ease: [], animate: [] };
  const NS = Object.keys(declared);
  for (const [, name] of theme.matchAll(/^\s*--([a-z]+-[a-z0-9-]+):/gm)) {
    const ns = NS.find((n) => name.startsWith(`${n}-`));
    if (ns === undefined) continue;
    const key = name.slice(ns.length + 1);
    if (key === '*' || key.includes('--')) continue;
    declared[ns].push(key);
  }
  // 字体命名空间里只有 sans / mono 是真档位，`--font-weight-*` 不清零也不登记
  declared.font = declared.font.filter((k) => ['sans', 'mono'].includes(k));

  const cn = readFileSync(CN, 'utf8');
  const listed = {};
  for (const ns of NS) {
    const block = new RegExp(`${ns}:\\s*\\[([^\\]]*)\\]`).exec(cn);
    listed[ns] = block === null ? [] : [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  for (const ns of NS) {
    const missing = declared[ns].filter((k) => !listed[ns].includes(k));
    const extra = listed[ns].filter((k) => !declared[ns].includes(k));
    if (missing.length > 0) problems.push(`lib/cn.ts 的 ${ns} 表缺少：${missing.join('、')}`);
    if (extra.length > 0) problems.push(`lib/cn.ts 的 ${ns} 表多出（@theme 里没有）：${extra.join('、')}`);
  }
}

// 两处深色定义必须逐字节一致
const followSystem = /@media \(prefers-color-scheme: dark\) \{\s*:root([^{]*)\{([\s\S]*?)\n {2}\}\n\}/.exec(css);
const manual = /\n:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/.exec(css);
if (followSystem === null) {
  problems.push('styles.css：找不到跟随系统的深色块');
} else if (!followSystem[1].includes(":not([data-theme='light'])")) {
  problems.push(
    `styles.css：跟随系统的深色块选择器是 ':root${followSystem[1].trim()}'，缺少 :not([data-theme='light'])——` +
      '系统深色下用户手动选浅色会失效',
  );
}
if (manual === null) {
  problems.push("styles.css：找不到 :root[data-theme='dark'] 的深色块");
}
if (followSystem !== null && manual !== null) {
  const normalize = (s) => s.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('\n');
  if (normalize(followSystem[2]) !== normalize(manual[1])) {
    problems.push('styles.css：两处深色定义不一致——跟随系统与手动选择必须给出同一套颜色');
  }
}

if (problems.length > 0) {
  console.error('\n✗ 设计 token 边界（ADR-0073）：\n');
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error('\n组件只能用语义别名层；新增一档要同时改 styles.css 的 @theme 与 lib/cn.ts 的表。\n');
  process.exit(1);
}

console.log('✓ 设计 token：组件零字面色值、零调色板直引，@theme 与 cn.ts 一致，两处深色定义一致');
