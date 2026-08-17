#!/usr/bin/env node
/**
 * 运行时不变量的**离线扫描器**（ADR-0060 的遗留项）。
 *
 * `SessionRuntime` 只在**写入路径**上核不变量：`open()` 的回放刻意不核，
 * 因为老会话可能带着历史缺陷，开机即报会让人当场把这道闸门关掉。
 * 代价是"历史库里已经存在的违例"查不出来——这个脚本就是补那一格。
 *
 *   node scripts/scan-invariants.mjs                   # 扫平台数据目录下的全部会话
 *   node scripts/scan-invariants.mjs --data <目录>      # 指定数据目录
 *   node scripts/scan-invariants.mjs --session <id>    # 只扫一个会话
 *
 * **它是诊断，不是闸门**：不进 `pnpm verify` 的失败判定。让它保持有人跑的办法是
 * `packages/runtime/tests/scan-invariants.test.ts`——那条用例造一个带已知违例的库，
 * 断言扫描逻辑捞得出来。没有那条用例，它就是下一个"写完再没跑过"的脚本。
 *
 * 判断逻辑全在 `@xm/runtime` 的 `scanAllSessions()` 里，这里只负责接线与打印。
 * 跑的是 `dist/`，与 `smoke-headless.mjs` 同一姿势：先 `tsc -b`。
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { nodePlatform } from '../packages/platform/dist/index.js';
import { openStores } from '../packages/storage/dist/index.js';
import { createInvariantRegistry, scanAllSessions } from '../packages/runtime/dist/index.js';

const argOf = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const dataDir = argOf('data');
const sessionId = argOf('session');

const platform = nodePlatform({
  appPath: fileURLToPath(new URL('..', import.meta.url)),
  ...(dataDir === undefined ? {} : { dataDir }),
});
const stores = await openStores(platform.paths());
const { registry, dispose } = createInvariantRegistry();

try {
  const results = await scanAllSessions({
    events: stores.events,
    registry,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  if (sessionId !== undefined && results.length === 0) {
    console.error(`✗ 库里没有会话 ${sessionId}`);
    process.exit(2);
  }

  let events = 0;
  let violations = 0;
  for (const result of results) {
    events += result.events;
    if (result.violations.length === 0) continue;
    violations += result.violations.length;
    console.error(
      `\n✗ 会话 ${result.sessionId} —— ${String(result.violations.length)} 处违例：`,
    );
    for (const v of result.violations) {
      console.error(`  · seq ${String(v.seq)} [${v.eventType}] ${v.package} / ${v.invariant}`);
      console.error(`    ${v.message}`);
    }
  }

  const scope = `${String(results.length)} 个会话、${String(events)} 条事件`;
  if (violations > 0) {
    console.error(
      `\n共 ${String(violations)} 处违例（扫了 ${scope}，${String(registry.size)} 条不变量）。\n`,
    );
    process.exitCode = 1;
  } else {
    console.log(`✓ 零违例：${scope}，${String(registry.size)} 条不变量。`);
  }
} finally {
  dispose();
  await stores.close();
}
