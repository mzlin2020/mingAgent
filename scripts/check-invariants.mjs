#!/usr/bin/env node
/**
 * 伴生不变量模块的闸门（ADR-0060）。
 *
 * 它拦四件事：
 *   1. 缺伴生模块 —— 每个包都要有 `src/invariant.ts`，哪怕结论是"没有"。
 *   2. 注册名与包名不符 —— 违例报告里的署名必须能一眼定位到包。
 *   3. 空 installer 没有理由 —— "这个包没有运行时不变量"是一个**结论**，
 *      要写清楚为什么，并在它长出可变状态时被重新审视。
 *   4. **伪不变量** —— 断言"某个服务/方法/插件存在"的那一类。
 *      那是类型与加载期的职责；把它写成不变量只会得到一条永远绿的断言，
 *      而永远绿的断言正是本仓库栽过八次的那种东西。
 *
 * 第 4 条用两个判据一起判，任一命中即拒收：
 *   · 检查函数**不引用**它的入参（`event` / `before` / `after`）——不看事件流的
 *     东西不是事件流上的不变量；
 *   · 不变量的名字长得像"××存在"。
 *
 * 还有第 5 条：**非空的伴生模块必须真的被装配接上**（`invariant-install.ts`）。
 * 写了一堆断言却没人注册，是这套机制自己身上最容易长出来的那种失效。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const INSTALL_FILE = join(PACKAGES, 'runtime/src/invariant-install.ts');

/** 名字长得像"××存在"的不变量。它们检验的是加载期的事，不是运行期的关系。 */
const FAKE_NAME = /(服务|方法|插件|模块|注册表)[^，。]{0,6}(存在|在位|装上|加载)|exists|is\s+defined|注册了/;

const problems = [];

/** 粗暴但够用的去注释：判据只看代码，中文注释里出现"服务存在"不该被误判。 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** 从 `api.on(` 起按括号配平取出整段调用源码 */
const registrations = (code) => {
  const found = [];
  let index = code.indexOf('api.on(');
  while (index >= 0) {
    let depth = 0;
    let end = index + 'api.on'.length;
    for (; end < code.length; end += 1) {
      const ch = code[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(code.slice(index, end + 1));
    index = code.indexOf('api.on(', end);
  }
  return found;
};

const nameOf = (call) => {
  const match = /,\s*(['"`])([\s\S]*?)\1\s*,/.exec(call);
  return match?.[2] ?? '';
};

const camel = (pkg) => pkg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const install = existsSync(INSTALL_FILE) ? readFileSync(INSTALL_FILE, 'utf8') : '';
let total = 0;
let nonEmpty = 0;

for (const pkg of packages) {
  const file = join(PACKAGES, pkg, 'src/invariant.ts');
  const rel = `packages/${pkg}/src/invariant.ts`;
  if (!existsSync(file)) {
    problems.push(`${rel}：缺伴生模块。没有运行时不变量也要写一个空 installer 并说明理由。`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  const code = stripComments(source);

  const expected = `${camel(pkg)}Invariants`;
  if (!code.includes(`export const ${expected}`)) {
    problems.push(`${rel}：导出名应当是 \`${expected}\`（注册名与包名必须对得上）。`);
  }

  const calls = registrations(code);
  total += calls.length;
  if (calls.length === 0) {
    if (!/无运行时不变量：/.test(source)) {
      problems.push(
        `${rel}：空 installer 必须写一句以「无运行时不变量：」开头的理由，` +
          `并说明它在什么条件下失效。`,
      );
    }
    continue;
  }

  nonEmpty += 1;
  if (!install.includes(`'@xm/${pkg}'`)) {
    problems.push(
      `${rel}：有 ${String(calls.length)} 条断言，却没有出现在 ` +
        `packages/runtime/src/invariant-install.ts 里——没人注册的不变量永远不会跑。`,
    );
  }

  for (const call of calls) {
    const name = nameOf(call);
    if (name === '') {
      problems.push(`${rel}：有一处 api.on 取不到不变量名字（第二个参数必须是字面量）。`);
      continue;
    }
    if (FAKE_NAME.test(name)) {
      problems.push(
        `${rel}：不变量「${name}」断言的是"东西存在"，那是类型与加载期的职责。` +
          `运行时不变量只断言**可观察的关系**（事件之间、或自己拥有的可变数据之间）。`,
      );
    }
    const body = call.slice(call.indexOf(name) + name.length);
    if (!/\b(event|before|after)\b/.test(body)) {
      problems.push(
        `${rel}：不变量「${name}」的检查函数一次都没读它的入参` +
          `（event / before / after）——不看事件流的东西不是事件流上的不变量，` +
          `它多半是在断言某个闭包捕获来的服务。`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\n✗ 运行时不变量（ADR-0060）不满足：\n');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `✓ 运行时不变量：${String(packages.length)} 个包都发布了伴生模块，` +
    `其中 ${String(nonEmpty)} 个有断言（共 ${String(total)} 条），均已接入装配。`,
);
