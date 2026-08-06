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
 * 检查三件事：
 *   一、**语法**。能不能解析。这一条就足以拦住上面那次。
 *   二、**回归**。desktop job 的启动自检必须跑打包产物，不能退回 `electron .`。
 *       那是 ADR-0016 补记二记的第九次：CI 步骤与它自己的注释说的不是一回事，
 *       而"改回去更省事"的诱惑一直在（跑产物要处理三平台路径、要签名）。
 *   三、**缓存与依赖要对得上**。开了包管理器缓存的 job 必须真的装依赖。
 *       见下面那段——**这一条自己就栽过一次**：它的第一版编码的是上次的修法
 *       而不是不变量，于是既拦不住 run #9，又会把正确的修法判成违规。
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
     * ── 三、开了包管理器缓存的 job，必须真的装依赖 ──
     *
     * `actions/setup-node@v5` 的 `package-manager-cache` 默认 true：读到
     * package.json 的 `packageManager` 就自动开缓存。开了之后有两头要交代——
     *
     *   pre  步骤要**找得到 pnpm**，否则：Unable to locate executable file: pnpm
     *   post 步骤要**存得下缓存**，否则：Path Validation Error: Path(s) ... do(es) not exist
     *
     * `secrets` job 两头都栽过：它零依赖，看起来"不需要 pnpm"，于是先挂在 pre（run #2 前后），
     * 装上 pnpm 之后又挂在 post（run #9）——而 post 的报错出现在 "Post job cleanup" 里，
     * 离原因更远、更难认。
     *
     * ── 这条检查自己也是一次教训 ──
     *
     * 它的第一版写的是「setup-node 之前必须先装 pnpm」。那**编码的是上一次的修法，
     * 不是不变量**：于是它既拦不住 post 那一头（run #9 照样红），
     * 又会把正确的修法（关掉缓存、连 pnpm 一起去掉）判成违规。
     *
     * 真正的不变量只有一条：**缓存要么整个不开，要么开了就得有依赖被装出来。**
     */
    const usesIdx = (prefix) => steps.findIndex((s) => String(s?.uses ?? '').startsWith(prefix));
    const nodeIdx = usesIdx('actions/setup-node');

    if (nodeIdx !== -1) {
      const nodeStep = steps[nodeIdx];
      const withBlock = nodeStep?.with ?? {};
      // 显式关掉自动缓存，且没有显式 `cache:` —— 这条路不碰缓存，两头都不用交代
      const cacheOff = withBlock['package-manager-cache'] === false && withBlock.cache === undefined;

      if (!cacheOff) {
        const pnpmIdx = usesIdx('pnpm/action-setup');
        if (pnpmIdx === -1 || pnpmIdx > nodeIdx) {
          problems.push(
            `${path} · job "${jobName}" 开着包管理器缓存，但 actions/setup-node 之前没有 pnpm/action-setup。\n` +
              `    setup-node 的 pre 步骤会去找 pnpm，找不到就直接失败\n` +
              `    （Unable to locate executable file: pnpm）。\n` +
              `    不需要依赖的 job 请写 \`package-manager-cache: false\`，而不是补一行 pnpm。`,
          );
        }

        const installs = steps.some((s) => /\bpnpm\b[^\n]*\binstall\b/.test(String(s?.run ?? '')));
        if (!installs) {
          problems.push(
            `${path} · job "${jobName}" 开着包管理器缓存，却从不 \`pnpm install\`。\n` +
              `    post 步骤会去存缓存，而那个目录根本不存在，于是整个 job 在\n` +
              `    "Post job cleanup" 里变红：Path Validation Error（run #9 就是这么挂的）。\n` +
              `    要么装依赖，要么写 \`package-manager-cache: false\` 把这条路整个关掉。`,
          );
        }
      }
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
