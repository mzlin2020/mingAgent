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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { newCallId, newSessionId } from '../packages/contracts/dist/index.js';
import {
  ToolRegistry,
  builtinLayers,
  pureGateway,
  emptySessionState,
  policyEnvFromPaths,
  reduce,
} from '../packages/kernel/dist/index.js';
import { nodePlatform } from '../packages/platform/dist/index.js';
import { openStores } from '../packages/storage/dist/index.js';
import {
  coreTools,
  nodeCheckpointer,
  nodeToolGateway,
} from '../packages/tools-core/dist/index.js';
import {
  DEMO_ECHO,
  DEMO_FAKE_DELETE,
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  TODO_UPDATE,
  demoTargetOf,
  echoTool,
  fakeDeleteTool,
  resultExpandTool,
  runTurn,
  textInput,
  todoUpdateTool,
} from '../packages/runtime/dist/index.js';

// fileURLToPath 而不是 `.pathname`：后者在 Windows 上是 `/D:/a/...` 这种带
// 前导斜杠的 URL 路径，不是合法的文件系统路径（同一个坑见 check-file-size.mjs）。
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
const dataDir = mkdtempSync(join(tmpdir(), 'xm-headless-'));
/** 主 DoD 任务的工作区。真文件、真读写——闸门第一次被真实输入喂 */
const workspace = mkdtempSync(join(tmpdir(), 'xm-workspace-'));

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

try {
  // 红线演练使用隔离的临时主目录，避免 smoke 依赖或触碰运行者的真实主目录。
  const platform = nodePlatform({ appRoot: APP_ROOT, dataDir, home: workspace });
  const paths = platform.paths();
  const stores = await openStores(paths);
  const layers = builtinLayers(policyEnvFromPaths(paths));

  const bus = new EventBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));

  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus });
  await runtime.record({
    type: 'session.created',
    // 会话的工作目录就是那个临时工作区：网关据此把模型给的相对路径变成绝对路径
    payload: { cwd: workspace, modelRef: 'scripted/scripted-1', title: 'headless 冒烟' },
  });

  const tools = new ToolRegistry();
  tools.register(echoTool());
  tools.register(fakeDeleteTool());
  tools.register(
    todoUpdateTool(async ({ sessionId: target, todos }) => {
      if (target !== sessionId) throw new Error('todo.update 写到了错误会话');
      const turnId = runtime.state.activeTurn?.turnId;
      await runtime.record({
        type: 'todo.updated',
        payload: { todos: [...todos] },
        ...(turnId === undefined ? {} : { turnId }),
      });
    }),
  );
  tools.register(
    resultExpandTool({
      blobs: stores.blobs,
      resolveRef: async ({ sessionId: target, hash }) => {
        if (target !== sessionId) return undefined;
        for await (const event of runtime.read()) {
          if (event.type === 'tool.end' && event.payload.fullRef?.hash === hash) {
            return event.payload.fullRef;
          }
        }
        return undefined;
      },
    }),
  );
  for (const t of coreTools({ os: platform.os })) tools.register(t);

  const echoCall = newCallId();
  const todoCall = newCallId();
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
          ...toolCall(todoCall, TODO_UPDATE, {
            todos: [{ id: 'smoke', content: '完成 headless 冒烟', status: 'in_progress' }],
          }),
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
      layers,
      model: 'scripted-1',
      gateway: pureGateway(demoTargetOf),
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('试一下这两个工具'),
  );

  // ── 第二段：主 DoD 任务的形状（读目录 → 读文件 → 写 README）──
  //
  // M1 的主 DoD 任务是"读这个目录、总结代码结构、写一个 README"。这里用脚本化
  // Provider 走同一条链子：真实文件工具、真实临时目录、真实审批。
  // 它验的不是模型会不会总结，是**闸门与工具在真实输入下配合得对不对**。
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const hello = 1;\n');

  const listCall = newCallId();
  const readCall = newCallId();
  const write1 = newCallId();
  const write2 = newCallId();

  const fileProvider = new ScriptedProvider({
    turns: [
      { chunks: [...toolCall(listCall, 'fs.list', { path: '.', depth: 2 }),
                 ...toolCall(readCall, 'fs.read', { path: 'src/index.ts' }),
                 { kind: 'stop', reason: 'tool_use' }] },
      { chunks: [...toolCall(write1, 'fs.write', { path: 'README.md', content: '# 项目\n' }),
                 { kind: 'stop', reason: 'tool_use' }] },
      // 第二次写**同一个文件**：照样零确认框（ADR-0039 之后不存在"第二次还问一遍"）
      { chunks: [...toolCall(write2, 'fs.write', { path: 'README.md', content: '# 项目\n\n补一句。\n' }),
                 { kind: 'stop', reason: 'tool_use' }] },
      { chunks: [{ kind: 'text_delta', text: 'README 写好了。' }, { kind: 'stop', reason: 'end_turn' }] },
    ],
  });

  /** 放行不留痕（ADR-0039）：这一整段跑完，权限事件条数必须一动不动 */
  const permissionEventCount = () =>
    seen.filter((e) => e.type === 'permission.request' || e.type === 'permission.decision').length;
  const permBeforeFileTurn = permissionEventCount();

  const fileReason = await runTurn(
    {
      runtime,
      provider: fileProvider,
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      checkpointer: nodeCheckpointer({ blobs: stores.blobs }),
      blobs: stores.blobs,
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('读一下这个目录，总结结构，写一个 README'),
  );
  const permAfterFileTurn = permissionEventCount();

  // ── 第三段：M2-b 搜索 → 统一截断 → 会话内按范围展开 ────────
  const searchFixture = Array.from(
    { length: 120 },
    (_, index) => `needle-${String(index + 1).padStart(3, '0')} ${'x'.repeat(900)}`,
  ).join('\n');
  writeFileSync(join(workspace, 'search-fixture.txt'), searchFixture);
  const searchCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              ...toolCall(searchCall, 'search.text', {
                pattern: 'needle-',
                path: '.',
                glob: ['search-fixture.txt'],
                maxResults: 100,
              }),
              { kind: 'stop', reason: 'tool_use' },
            ],
          },
          { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      blobs: stores.blobs,
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('在夹具仓库搜索 needle'),
  );
  const searchEnd = seen.find(
    (event) => event.type === 'tool.end' && event.payload.callId === searchCall,
  );
  const searchRef = searchEnd?.payload.fullRef;
  let searchExpanded = false;
  if (searchRef !== undefined) {
    const expandCall = newCallId();
    await runTurn(
      {
        runtime,
        provider: new ScriptedProvider({
          turns: [
            {
              chunks: [
                ...toolCall(expandCall, 'result.expand', {
                  ref: `blob:sha256:${searchRef.hash}`,
                  offset: 95,
                  limit: 3,
                }),
                { kind: 'stop', reason: 'tool_use' },
              ],
            },
            { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
          ],
        }),
        tools,
        layers,
        model: 'scripted-1',
        gateway: nodeToolGateway(),
        blobs: stores.blobs,
        pathCaseInsensitive: platform.os === 'windows',
      },
      textInput('只展开搜索结果第 95 到 97 行'),
    );
    searchExpanded = seen.some(
      (event) =>
        event.type === 'tool.end' &&
        event.payload.callId === expandCall &&
        JSON.stringify(event.payload.forModel).includes('search-fixture.txt'),
    );
  }

  // ── 第四段：M1-d 的 DoD —— rm -rf ~ 的四种写法判定一致 ──────
  //
  // 这一段跑的是真实的 `shell.exec` 工具与真实的能力网关，但**一次也不会真的
  // spawn 出去**：四种写法全都在闸门那里就被拦住了。断言的不只是"都被拦"，
  // 还有"命中的是同一条规则"——三种 deny 加一种 ask 也能叫"都拦下了"，
  // 但那时第四种的下一步是用户点允许。
  const dodRules = [];
  /** 拒绝会成对记下 request+decision（审计）；放行一条都不记 —— 这就是"零确认框"的度量 */
  const requestCount = (from) => seen.slice(from).filter((e) => e.type === 'permission.request').length;
  const dodRequests = [];
  const writings = [
    ['朴素', ['rm', '-rf', '~']],
    ['绝对路径的 bin', ['/bin/rm', '-rf', '~']],
    ['sh -c 包一层', ['sh', '-c', 'rm -rf ~']],
    ['env 包一层', ['env', 'FOO=1', 'rm', '-rf', '~']],
  ];

  for (const [, argv] of writings) {
    const before = seen.length;
    await runTurn(
      {
        runtime,
        provider: new ScriptedProvider({
          turns: [
            { chunks: [...toolCall(newCallId(), 'shell.exec', { argv }), { kind: 'stop', reason: 'tool_use' }] },
            { chunks: [{ kind: 'text_delta', text: '好。' }, { kind: 'stop', reason: 'end_turn' }] },
          ],
        }),
        tools,
        layers,
        model: 'scripted-1',
        gateway: nodeToolGateway({ home: paths.home }),
        pathCaseInsensitive: platform.os === 'windows',
      },
      textInput('删掉我的家目录'),
    );
    const decision = seen
      .slice(before)
      .find((e) => e.type === 'permission.decision' && e.payload.effect === 'deny');
    dodRules.push(decision?.payload.ruleId);
    dodRequests.push(requestCount(before));
  }

  // 一条正常命令必须还能跑起来——全拦下不叫防住了，叫不能用了
  let shellRan = false;
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              ...toolCall(newCallId(), 'shell.exec', {
                argv: [process.execPath, '-e', 'process.stdout.write("hello-xm")'],
              }),
              { kind: 'stop', reason: 'tool_use' },
            ],
          },
          { chunks: [{ kind: 'text_delta', text: '好。' }, { kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway({ home: paths.home }),
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('打个招呼'),
  );
  shellRan = seen.some(
    (e) => e.type === 'tool.end' && e.payload.ok && JSON.stringify(e.payload.forModel).includes('hello-xm'),
  );

  // ── 第五段：多模态最小反向演练 ──────────────────────────────
  //
  // 贯穿"组装 ContentBlock[] → runTurn → 事件落库 → blob 落盘"整条链路——
  // 其余多模态测试都是分层单测（runtime 的能力闸门、Provider 的 wire 编码、
  // 桌面端的 IPC schema 各自独立验），这是唯一一处把四层串起来跑一遍的地方。
  const imageBytes = Buffer.from('这不是真的图片字节，只是用来验证 blob 落盘与事件回放', 'utf8');
  const imageRef = await stores.blobs.put(imageBytes, 'image/png', 'demo.png');

  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        capabilities: { vision: true },
        turns: [
          { chunks: [{ kind: 'text_delta', text: '看到了。' }, { kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: pureGateway(demoTargetOf),
      pathCaseInsensitive: platform.os === 'windows',
    },
    [{ type: 'image', source: imageRef }, ...textInput('这张图是什么')],
  );

  // 落盘之后、关库之前查一次——`stores.close()` 之后 `stores.blobs` 就不能再用了
  const imageStat = await stores.blobs.stat(imageRef);

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
  if (!types.includes('todo.updated') || replayed.todos[0]?.id !== 'smoke') {
    fail('todo.update 没有贯穿工具调用→事件落库→重开放回放');
  }
  if (!seen.some((e) => e.type === 'message.delta')) fail('总线上没有 message.delta，流式没生效');

  if (JSON.stringify(serialize(replayed)) !== JSON.stringify(serialize(memoryState))) {
    fail('重开库回放出的状态与进程内不一致 —— 事件流不再是唯一真相');
  }

  // ── 主 DoD 任务这一段的断言 ────────────────────────────────
  if (fileReason !== 'end_turn') fail(`文件回合应正常结束，实际 ${fileReason}`);

  const readme = join(workspace, 'README.md');
  let readmeText = '';
  try {
    readmeText = readFileSync(readme, 'utf8');
  } catch {
    fail('README.md 没有被真的写出来 —— 工具链没有跑通');
  }
  if (readmeText !== '' && !readmeText.includes('补一句')) {
    fail('第二次写入没有生效 —— 那一次调用被拦下了');
  }

  // ADR-0039：整段 fs.list → fs.read → fs.write ×2 一条权限事件都不该产生
  if (permAfterFileTurn !== permBeforeFileTurn) {
    fail(
      `主 DoD 任务应零确认框（放行不留痕），实际多出 ${String(permAfterFileTurn - permBeforeFileTurn)} 条权限事件`,
    );
  }
  if (!types.includes('checkpoint.created')) {
    fail('覆盖 README 之前没有还原点 —— ADR-0003 的"无条件还原点"没落地');
  }
  if (!seen.some((e) => e.type === 'tool.progress')) {
    fail('总线上没有 tool.progress —— 工具进度显示不出来');
  }
  if (searchRef === undefined) {
    fail('search.text 的超量结果没有经过统一截断写入 BlobStore');
  } else if (!searchExpanded) {
    fail('result.expand 没有按范围展开当前会话的搜索全文');
  }

  // ── M1-d DoD 的断言 ────────────────────────────────────────
  for (const [i, [label]] of writings.entries()) {
    if (dodRules[i] !== 'red.fs-delete-home-root') {
      fail(`\`rm -rf ~\` 的写法「${label}」应由 red.fs-delete-home-root 拦下，实际 ruleId=${dodRules[i]}`);
    }
  }
  if (new Set(dodRules).size !== 1) {
    fail(`四种写法判定不一致：${JSON.stringify(dodRules)}`);
  }
  // 每种写法恰好一条 request：拒绝的审计记录，不是确认框
  for (const [i, [label]] of writings.entries()) {
    if (dodRequests[i] !== 1) {
      fail(`写法「${label}」应恰好留一条拒绝审计，实际 ${String(dodRequests[i])} 条`);
    }
  }
  if (seen.some((e) => e.type === 'permission.decision' && e.payload.by !== 'policy')) {
    fail('事件流里出现了 by !== policy 的权限决定 —— 已经没有人能做这个决定了');
  }
  if (!shellRan) {
    fail('普通命令没跑起来 —— 全拦下不叫防住了，叫不能用了');
  }

  // ── 多模态最小反向演练的断言 ──────────────────────────────
  if (imageStat === undefined) {
    fail('图片没有真的落进 BlobStore');
  }
  const turnStartWithImage = seen.some(
    (e) => e.type === 'turn.start' && JSON.stringify(e.payload.input ?? []).includes(imageRef.hash),
  );
  if (!turnStartWithImage) {
    fail('turn.start 事件里没有看到图片块 —— ContentBlock[] 没有被如实记录');
  }
  const replayedHasImage = replayed.messages.some((m) =>
    m.blocks.some((b) => b.type === 'image' && b.source.hash === imageRef.hash),
  );
  if (!replayedHasImage) {
    fail('重开库回放出的消息里没有图片块 —— 多模态输入没有活过事件流的往返');
  }

  if (process.exitCode !== 1) {
    console.log(
      `✓ headless 冒烟通过：${String(types.length)} 条持久事件、` +
        `${String(seen.length)} 条总线事件，回放状态一致；` +
        `主 DoD 任务跑通（fs.list → fs.read → fs.write ×2，零权限事件）；` +
        `M2-b 搜索→截断→会话内范围展开跑通；` +
        `rm -rf ~ 的四种写法全部由同一条红线拦下，普通命令照常跑；` +
        `多模态图片贯穿 组装→runTurn→事件落库→blob 落盘 跑通`,
    );
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** 一次工具调用的三个 chunk */
function toolCall(id, name, args) {
  return [
    { kind: 'tool_call_start', id, name },
    { kind: 'tool_call_delta', id, argsJson: JSON.stringify(args) },
    { kind: 'tool_call_end', id },
  ];
}

/** Map 不能直接 JSON 序列化，这里只用于比较，不追求好看 */
function serialize(state) {
  return {
    ...state,
    runningCalls: [...state.runningCalls.entries()],
    runningSubagents: [...state.runningSubagents.entries()],
  };
}
