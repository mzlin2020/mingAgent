#!/usr/bin/env node
/**
 * CI 配置的本地闸门。
 *
 * 由来：`.github/workflows/ci.yml` 至今**没有被任何东西检查过**——它是否合法，
 * 唯一的验证方式是推上去看 GitHub 报不报错。2026-08-05 就这样交了一次学费：
 *
 *   run: "$XM_APP_BIN" --smoke
 *
 * YAML 把开头的引号解析成引用标量，后面的 ` --smoke` 就成了非法尾巴，
 * **整个文件解析失败、六个 job 一个都没跑**。而本地 `pnpm verify` 全绿。
 *
 * 这是同一个模式的第十次：护栏（三平台 CI）本身没有护栏。
 * 所以它现在进 `verify`——推之前就能知道，而不是推之后。
 *
 * 检查两件事：
 *   一、**语法**。能不能解析。这一条就足以拦住上面那次。
 *   二、**回归**。desktop job 的启动自检必须跑打包产物，不能退回 `electron .`。
 *       那是 ADR-0016 补记二记的第九次：CI 步骤与它自己的注释说的不是一回事，
 *       而"改回去更省事"的诱惑一直在（跑产物要处理三平台路径、要签名）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = '.github/workflows';
const problems = [];

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) problems.push(`${DIR} 下一个 workflow 都没有——CI 是不是被整个删了？`);

for (const file of files) {
  const path = join(DIR, file);
  let doc;

  // ── 一、语法 ──────────────────────────────────────────────────
  try {
    doc = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    problems.push(`${path} 解析失败（GitHub 上的表现是所有 job 一个都不跑）：\n    ${String(e).split('\n')[0]}`);
    continue;
  }

  const jobs = doc?.jobs;
  if (jobs === undefined || typeof jobs !== 'object') {
    problems.push(`${path} 没有 jobs`);
    continue;
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = job?.steps ?? [];

    /*
     * ── 三、`setup-node` 之前必须先装 pnpm ──
     *
     * `actions/setup-node@v5` 会读 package.json 的 `packageManager` 字段**自动开启缓存**，
     * 于是它会去找 pnpm。找不到就直接失败：
     *   Error: Unable to locate executable file: pnpm.
     *
     * 首跑时六个 job 里只有 `secrets` 没装 pnpm（它零依赖，看起来"不需要"），
     * 也只有它挂在这一步——**差异本身就是 bug 的来源**，而这种差异靠读 YAML 很难看出来：
     * 每个 job 单独看都合理，只有并排比才发现少了一行。
     */
    const usesIdx = (prefix) => steps.findIndex((s) => String(s?.uses ?? '').startsWith(prefix));
    const nodeIdx = usesIdx('actions/setup-node');
    const pnpmIdx = usesIdx('pnpm/action-setup');
    if (nodeIdx !== -1 && (pnpmIdx === -1 || pnpmIdx > nodeIdx)) {
      problems.push(
        `${path} · job "${jobName}" 在 actions/setup-node 之前没有 pnpm/action-setup。\n` +
          `    setup-node@v5 会按 package.json 的 packageManager 自动开缓存并去找 pnpm，\n` +
          `    找不到就直接失败（Unable to locate executable file: pnpm）。`,
      );
    }

    for (const step of steps) {
      const run = typeof step?.run === 'string' ? step.run : '';
      if (run === '') continue;

      // ── 二、回归：启动自检必须跑打包产物 ──────────────────────
      //
      // `electron .` 跑的是 apps/desktop 的 main（dist/main/index.js）——源码树，
      // 没有 asar。而这个 job 存在的意义就是验 asar 那一侧
      // （`.node` 有没有被 asarUnpack 出来、`files` 有没有漏 prebuilds/）。
      if (/\belectron\s+\.(\s|$)/.test(run)) {
        problems.push(
          `${path} · job "${jobName}" · 步骤「${step.name ?? '(无名)'}」跑的是 \`electron .\`。\n` +
            `    那是源码树、没有 asar，恰好绕开了这个 job 唯一要验的东西（ADR-0016 补记二）。\n` +
            `    要跑 release/ 下打包出来的可执行文件。`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('❌ workflow 检查未通过：\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}

console.log(`✓ workflow 检查通过：${String(files.length)} 个文件语法合法，启动自检跑的是打包产物`);
