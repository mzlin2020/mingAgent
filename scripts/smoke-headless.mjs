/**
 * headless 冒烟 —— 独立可执行版本。
 *
 * 与 `packages/runtime/tests/smoke.test.ts` 验的是同一件事，但**跑的是 `dist/`**：
 * 测试走 vitest 的源码别名，一次也不会加载真正发布出去的产物。而 M0-b 的两个
 * 真实风险恰好都只在产物上暴露——
 *
 *   · `package.json` 的 `exports` / `main` 写错，源码测试全绿而 `import` 不到
 *   · better-sqlite3 的原生模块没编好（Node ABI 与 Electron ABI 是两轨，ADR-0016）
 *
 * 所以它不是测试的复制品，是补上"产物能不能用"这一格。
 *
 *   node scripts/smoke-headless.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { newCallId, newSessionId } from '../packages/contracts/dist/index.js';
import {
  ToolRegistry,
  builtinRules,
  emptySessionState,
  policyEnvFromPaths,
  reduce,
} from '../packages/kernel/dist/index.js';
import { nodePlatform } from '../packages/platform/dist/index.js';
import { openStores } from '../packages/storage/dist/index.js';
import {
  DEMO_ECHO,
  DEMO_FAKE_DELETE,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  demoTargetOf,
  echoTool,
  fakeDeleteTool,
  runTurn,
} from '../packages/runtime/dist/index.js';

const APP_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dataDir = mkdtempSync(join(tmpdir(), 'xm-headless-'));

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

try {
  const platform = nodePlatform({ appRoot: APP_ROOT, dataDir });
  const paths = platform.paths();
  const stores = await openStores(paths);
  const rules = builtinRules(policyEnvFromPaths(paths));

  const bus = new EventBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));

  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: process.cwd(), modelRef: 'scripted/scripted-1', title: 'headless 冒烟' },
  });

  const tools = new ToolRegistry();
  tools.register(echoTool());
  tools.register(fakeDeleteTool());

  const echoCall = newCallId();
  const denyCall = newCallId();

  const provider = new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'thinking_delta', text: '先回显，再试一次删家目录。' },
          { kind: 'text_delta', text: '好的。' },
          { kind: 'tool_call_start', id: echoCall, name: DEMO_ECHO },
          { kind: 'tool_call_delta', id: echoCall, argsJson: '{"text":"你好，小明"}' },
          { kind: 'tool_call_end', id: echoCall },
          { kind: 'tool_call_start', id: denyCall, name: DEMO_FAKE_DELETE },
          { kind: 'tool_call_delta', id: denyCall, argsJson: JSON.stringify({ path: paths.home }) },
          { kind: 'tool_call_end', id: denyCall },
          {
            kind: 'usage',
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
          { kind: 'stop', reason: 'tool_use' },
        ],
      },
      {
        chunks: [
          { kind: 'text_delta', text: '做完了。' },
          { kind: 'stop', reason: 'end_turn' },
        ],
      },
    ],
  });

  const reason = await runTurn(
    {
      runtime,
      provider,
      tools,
      rules,
      tier: 'balanced',
      model: 'scripted-1',
      targetOf: demoTargetOf,
      pathCaseInsensitive: platform.os === 'windows',
    },
    '试一下这两个工具',
  );

  const memoryState = runtime.state;
  await runtime.close();
  await stores.close();

  const reopened = await openStores(paths);
  let replayed = emptySessionState(sessionId);
  const types = [];
  for await (const e of reopened.events.read(sessionId)) {
    types.push(e.type);
    replayed = reduce(replayed, e);
  }
  await reopened.close();

  // ── 断言 ────────────────────────────────────────────────────
  if (reason !== 'end_turn') fail(`回合应正常结束，实际 ${reason}`);

  const denied = seen.find(
    (e) => e.type === 'permission.decision' && e.payload.effect === 'deny',
  );
  if (denied === undefined) fail('删家目录必须被拒绝 —— 闸门没长在路径上');
  else if (denied.payload.ruleId !== 'red.fs-delete-home-root') {
    fail(`应由红线拦下，实际 ruleId=${denied.payload.ruleId}`);
  }

  if (types.includes('message.delta') || types.includes('tool.progress')) {
    fail('瞬态事件落库了（ADR-0008）');
  }
  if (!seen.some((e) => e.type === 'message.delta')) fail('总线上没有 message.delta，流式没生效');

  if (JSON.stringify(serialize(replayed)) !== JSON.stringify(serialize(memoryState))) {
    fail('重开库回放出的状态与进程内不一致 —— 事件流不再是唯一真相');
  }

  if (process.exitCode !== 1) {
    console.log(
      `✓ headless 冒烟通过：${String(types.length)} 条持久事件、` +
        `${String(seen.length)} 条总线事件，回放状态一致`,
    );
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

/** Map 不能直接 JSON 序列化，这里只用于比较，不追求好看 */
function serialize(state) {
  return {
    ...state,
    runningCalls: [...state.runningCalls.entries()],
    runningSubagents: [...state.runningSubagents.entries()],
  };
}
