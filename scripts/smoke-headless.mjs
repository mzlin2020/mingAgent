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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { newCallId, newMessageId, newSessionId, newTurnId } from '../packages/contracts/dist/index.js';
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
  editApplyTool,
  editPreviewTool,
  nodeCheckpointer,
  nodeCheckpointRestorer,
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
  runSubagentExploration,
  runTurn,
  subagentExploreTool,
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
  const editAccess = {
    save: async (_target, proposal) => {
      const turnId = runtime.state.activeTurn?.turnId;
      await runtime.record({
        type: 'edit.proposed',
        payload: { proposal },
        ...(turnId === undefined ? {} : { turnId }),
      });
    },
    get: async (_target, proposalId) => {
      const item = runtime.state.editProposals.find(
        (candidate) => candidate.proposal.proposalId === proposalId,
      );
      return item === undefined
        ? undefined
        : { proposal: item.proposal, applied: item.appliedAt !== undefined };
    },
    markApplied: async (_target, proposalId) => {
      const turnId = runtime.state.activeTurn?.turnId;
      await runtime.record({
        type: 'edit.applied',
        payload: { proposalId },
        ...(turnId === undefined ? {} : { turnId }),
      });
    },
  };
  tools.register(editPreviewTool(editAccess));
  tools.register(editApplyTool(editAccess));
  for (const t of coreTools({ os: platform.os, index: stores.index })) tools.register(t);
  tools.register(
    subagentExploreTool(async (request) => {
      const childRead = newCallId();
      return runSubagentExploration(
        {
          parentRuntime: runtime,
          store: stores.events,
          bus,
          parentTools: tools,
          provider: new ScriptedProvider({
            turns: [
              { chunks: [...toolCall(childRead, 'fs.read', { path: 'src/symbol.ts' }), { kind: 'stop', reason: 'tool_use' }] },
              { chunks: [{ kind: 'text_delta', text: '子结论：smokeSymbol 位于 src/symbol.ts。' }, { kind: 'stop', reason: 'end_turn' }] },
            ],
          }),
          model: 'scripted-1',
          layers,
          gateway: nodeToolGateway(),
          blobs: stores.blobs,
          pathCaseInsensitive: platform.os === 'windows',
        },
        request,
      );
    }),
  );

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
  writeFileSync(join(workspace, 'src', 'symbol.ts'), 'export function smokeSymbol(): string { return "indexed smoke"; }\n');

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

  // M2-f 的 Git 闭环以当前工作区为基线；另造一份用户既有暂存，验证提交不会夹带。
  writeFileSync(join(workspace, 'user.txt'), 'user base\n');
  git(workspace, 'init', '-b', 'main');
  git(workspace, 'config', 'user.name', 'Headless Smoke');
  git(workspace, 'config', 'user.email', 'smoke@example.invalid');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'baseline');
  writeFileSync(join(workspace, 'user.txt'), 'user staged\n');
  git(workspace, 'add', 'user.txt');

  // ── 第四段：M2-d preview → 多文件 apply → 整组 checkpoint ──
  const editPreviewCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              ...toolCall(editPreviewCall, 'edit.preview', {
                files: [
                  { path: 'src/index.ts', replacements: [{ oldText: 'hello = 1', newText: 'hello = 2', expectedMatches: 1 }] },
                  { path: 'README.md', replacements: [{ oldText: '补一句。', newText: '精确编辑。', expectedMatches: 1 }] },
                ],
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
      checkpointer: nodeCheckpointer({ blobs: stores.blobs }),
      blobs: stores.blobs,
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('预览精确多文件编辑'),
  );
  const editProposal = runtime.state.editProposals.at(-1)?.proposal;
  const editApplyCall = newCallId();
  if (editProposal !== undefined) {
    await runTurn(
      {
        runtime,
        provider: new ScriptedProvider({
          turns: [
            {
              chunks: [
                ...toolCall(editApplyCall, 'edit.apply', {
                  proposalId: editProposal.proposalId,
                  files: editProposal.files.map((file) => ({ path: file.path, beforeHash: file.beforeHash })),
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
        checkpointer: nodeCheckpointer({ blobs: stores.blobs }),
        blobs: stores.blobs,
        pathCaseInsensitive: platform.os === 'windows',
      },
      textInput('应用精确多文件编辑'),
    );
  }
  const editApplied =
    editProposal !== undefined &&
    readFileSync(join(workspace, 'src', 'index.ts'), 'utf8').includes('hello = 2') &&
    readFileSync(join(workspace, 'README.md'), 'utf8').includes('精确编辑。') &&
    runtime.state.editProposals.at(-1)?.appliedAt !== undefined &&
    runtime.state.checkpoints.some((checkpoint) => checkpoint.callId === editApplyCall);

  /*
   * 上面那段是从**事件投影**里取的提案，真实模型没有这条捷径——它只能看 tool.end.forModel。
   * 旧实现在这里就断了：整份提案 JSON 撞上 64KB 截断，第二个文件的 beforeHash 被挖掉，
   * 于是 edit.apply 永远拼不出合法入参，而这条纵切因为读投影而全程绿着（ADR-0050）。
   */
  let editPreviewUsable = false;
  for await (const event of stores.events.read(runtime.sessionId)) {
    if (event.type !== 'tool.end' || event.payload.callId !== editPreviewCall) continue;
    const shown = event.payload.forModel
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    editPreviewUsable =
      editProposal !== undefined &&
      editProposal.files.every(
        (file) => shown.includes(file.beforeHash) && shown.includes(editProposal.proposalId),
      );
  }

  // ── 第五段：M2-f status → branch → diff → path-only commit ──
  const gitStatusCall = newCallId();
  const gitBranchCall = newCallId();
  const gitDiffCall = newCallId();
  const gitCommitCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          { chunks: [
            ...toolCall(gitStatusCall, 'git.status', {}),
            ...toolCall(gitBranchCall, 'git.branch', { argv: ['git', 'switch', '-c', 'codex/m2-f-smoke'] }),
            ...toolCall(gitDiffCall, 'git.diff', { argv: ['git', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'src/index.ts', 'README.md'] }),
            { kind: 'stop', reason: 'tool_use' },
          ] },
          { chunks: [
            ...toolCall(gitCommitCall, 'git.commit', { argv: ['git', 'commit', '--only', '-m', 'M2-f smoke', '--', 'src/index.ts', 'README.md'] }),
            { kind: 'stop', reason: 'tool_use' },
          ] },
          { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('查看 Git 状态，新建分支并只提交任务改动'),
  );
  const gitWorkflowPassed =
    git(workspace, 'branch', '--show-current').trim() === 'codex/m2-f-smoke' &&
    git(workspace, 'show', '--pretty=', '--name-only', 'HEAD').trim().split(/\r?\n/u).sort().join(',') === 'README.md,src/index.ts' &&
    git(workspace, 'diff', '--cached', '--name-only').trim() === 'user.txt' &&
    [gitStatusCall, gitBranchCall, gitDiffCall, gitCommitCall].every((callId) =>
      seen.some((event) => event.type === 'tool.end' && event.payload.callId === callId && event.payload.ok),
    );

  // ── 第六段：M2-g 冷索引 fallback → WASM 符号 + FTS5 ──────
  const coldSymbolCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          { chunks: [...toolCall(coldSymbolCall, 'search.symbol', { query: 'smokeSymbol', path: '.' }), { kind: 'stop', reason: 'tool_use' }] },
          { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('冷索引时查找符号'),
  );
  await stores.index.refresh(workspace, {
    aborted: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const readySymbolCall = newCallId();
  const indexedTextCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          { chunks: [
            ...toolCall(readySymbolCall, 'search.symbol', { query: 'smokeSymbol', path: '.' }),
            ...toolCall(indexedTextCall, 'search.indexed', { query: 'indexed smoke', path: '.' }),
            { kind: 'stop', reason: 'tool_use' },
          ] },
          { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
        ],
      }),
      tools,
      layers,
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      pathCaseInsensitive: platform.os === 'windows',
    },
    textInput('索引完成后查找符号与全文'),
  );
  const resultText = (callId) => JSON.stringify(
    seen.find((event) => event.type === 'tool.end' && event.payload.callId === callId)?.payload.forModel,
  );
  const indexWorkflowPassed =
    resultText(coldSymbolCall).includes('ripgrep-fallback') &&
    resultText(readySymbolCall).includes('tree-sitter-index') &&
    resultText(readySymbolCall).includes('smokeSymbol') &&
    resultText(indexedTextCall).includes('fts5-index') &&
    resultText(indexedTextCall).includes('src/symbol.ts');

  // ── 第七段：M2-h 75% 预算 → 持久摘要 → 重开复用 ───────────
  const contextSessionId = newSessionId();
  const contextRuntime = await SessionRuntime.open({ sessionId: contextSessionId, store: stores.events, bus });
  await contextRuntime.record({
    type: 'session.created',
    payload: { cwd: workspace, modelRef: 'scripted/scripted-1', title: 'M2-h smoke' },
  });
  for (let index = 0; index < 8; index += 1) {
    const turnId = newTurnId();
    await contextRuntime.record({
      type: 'turn.start',
      turnId,
      payload: { turnId, input: [{ type: 'text', text: `历史-${String(index)}-约束-${'甲'.repeat(360)}` }] },
    });
    const messageId = newMessageId();
    await contextRuntime.record({
      type: 'message.start',
      turnId,
      payload: { messageId, role: 'assistant', model: 'scripted-1' },
    });
    await contextRuntime.record({
      type: 'message.end',
      turnId,
      payload: {
        message: {
          id: messageId,
          role: 'assistant',
          model: 'scripted-1',
          blocks: [{ type: 'text', text: `历史-${String(index)}-决定-${'乙'.repeat(360)}` }],
          ts: index + 1,
        },
      },
    });
    await contextRuntime.record({ type: 'turn.end', turnId, payload: { turnId, reason: 'end_turn' } });
  }
  const persistedSummary = '未解决的问题：无。用户明确约束：保留约束。已做出的决定：沿用方案。已完成工作与关键证据：旧轮次已完成。';
  const compactProvider = new ScriptedProvider({
    capabilities: { maxContext: 6_000, maxOutput: 600, promptCache: true },
    turns: [
      { chunks: [{ kind: 'text_delta', text: persistedSummary }, { kind: 'stop', reason: 'end_turn' }] },
      { chunks: [{ kind: 'stop', reason: 'end_turn' }] },
    ],
  });
  await runTurn(
    { runtime: contextRuntime, provider: compactProvider, tools: new ToolRegistry(), layers: [], model: 'scripted-1', blobs: stores.blobs },
    textInput('当前消息原样保留'),
  );
  const compactedMain = compactProvider.requests[1];
  await contextRuntime.close();
  const reopenedContext = await SessionRuntime.open({ sessionId: contextSessionId, store: stores.events, bus });
  const replayContextProvider = new ScriptedProvider({
    capabilities: { maxContext: 100_000, maxOutput: 1_000, promptCache: true },
    turns: [{ chunks: [{ kind: 'stop', reason: 'end_turn' }] }],
  });
  await runTurn(
    { runtime: reopenedContext, provider: replayContextProvider, tools: new ToolRegistry(), layers: [], model: 'scripted-1', blobs: stores.blobs },
    textInput('重启后继续'),
  );
  const replayContextMain = replayContextProvider.requests[0];
  const contextWorkflowPassed =
    compactProvider.requests.length === 2 &&
    compactedMain !== undefined &&
    !JSON.stringify(compactedMain).includes('历史-0-约束') &&
    JSON.stringify(compactedMain).includes('历史-7-约束') &&
    JSON.stringify(compactedMain).includes('当前消息原样保留') &&
    reopenedContext.state.compactions.length === 1 &&
    replayContextProvider.requests.length === 1 &&
    replayContextMain?.system.some((segment) => segment.text.includes(persistedSummary)) === true;
  await reopenedContext.close();

  // ── 第八段：M2-i 独立 session/seq → 只读探索 → 结论回传 ──
  const exploreCall = newCallId();
  await runTurn(
    {
      runtime,
      provider: new ScriptedProvider({
        turns: [
          {
            chunks: [
              ...toolCall(exploreCall, 'agent.explore', {
                purpose: '只读检查 smokeSymbol 的定义位置',
                maxTurns: 3,
                timeoutMs: 10_000,
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
    textInput('派一个只读子 Agent 检查符号'),
  );
  const sessionSummaries = await stores.events.listSessions();
  const childSummary = sessionSummaries.find((item) => item.parentSessionId === sessionId);
  const childEvents = [];
  if (childSummary !== undefined) {
    for await (const event of stores.events.read(childSummary.sessionId)) childEvents.push(event);
  }
  const subagentEnd = seen.find(
    (event) =>
      event.type === 'subagent.end' &&
      event.payload.summary.some(
        (block) => block.type === 'text' && block.text.includes('src/symbol.ts'),
      ),
  );
  const subagentWorkflowPassed =
    childSummary !== undefined &&
    childEvents[0]?.seq === 1 &&
    childEvents.some((event) => event.type === 'tool.start' && event.payload.name === 'fs.read') &&
    subagentEnd?.type === 'subagent.end' &&
    subagentEnd.payload.reason === 'completed' &&
    runtime.state.runningSubagents.size === 0;

  // ── 第九段：M1-d 的 DoD —— rm -rf ~ 的四种写法判定一致 ──────
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

  // ── M2-c：从真实工具调用生成的 v2 manifest 撤销第二次 README 写入 ──
  const undoCheckpoint = runtime.state.checkpoints.find((checkpoint) => checkpoint.callId === write2);
  let checkpointRestored = false;
  if (undoCheckpoint?.manifestRef === undefined) {
    fail('第二次 README 写入没有生成可恢复的 v2 manifest');
  } else {
    await runtime.record({
      type: 'checkpoint.restore.started',
      payload: { checkpointId: undoCheckpoint.checkpointId },
    });
    await nodeCheckpointRestorer(stores.blobs).restore(undoCheckpoint.manifestRef);
    await runtime.record({
      type: 'checkpoint.restored',
      payload: { checkpointId: undoCheckpoint.checkpointId },
    });
    checkpointRestored = readFileSync(join(workspace, 'README.md'), 'utf8') === '# 项目\n';
  }

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
  if (readmeText !== '' && readmeText !== '# 项目\n') {
    fail('M2-c 整组撤销没有把 README 恢复到第二次写入前的字节');
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
  if (!checkpointRestored || !types.includes('checkpoint.restore.started') || !types.includes('checkpoint.restored')) {
    fail('M2-c 撤销没有贯穿 manifest → 文件恢复 → 审计事件 → 重开放回放');
  }
  if (searchRef === undefined) {
    fail('search.text 的超量结果没有经过统一截断写入 BlobStore');
  } else if (!searchExpanded) {
    fail('result.expand 没有按范围展开当前会话的搜索全文');
  }
  if (!editApplied || !types.includes('edit.proposed') || !types.includes('edit.applied')) {
    fail('M2-d 没有贯穿 preview → 多文件 apply → 整组 checkpoint → 事件回放');
  }
  if (!editPreviewUsable) {
    fail('edit.preview 给模型看的结果里缺少某个文件的 proposalId/beforeHash，模型无法发起 apply');
  }
  if (!gitWorkflowPassed) {
    fail('M2-f 没有贯穿 status → branch → diff → 显式范围 commit，或夹带了用户既有暂存');
  }
  if (!indexWorkflowPassed) {
    fail('M2-g 没有贯穿冷索引 fallback → tree-sitter WASM 符号 → FTS5 全文');
  }
  if (!contextWorkflowPassed) {
    fail('M2-h 没有贯穿 75% 预算 → 一次摘要 → 近期原文 → 重开放复用');
  }
  if (!subagentWorkflowPassed) {
    fail('M2-i 没有贯穿独立 session/seq → 只读工具 → 只回传结论 → 完整收尾');
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
        `M2-c v2 manifest→撤销→重开放回放跑通；` +
        `M2-d preview→多文件 apply→整组 checkpoint 跑通；` +
        `M2-f status→branch→diff→显式范围 commit 跑通且未夹带既有暂存；` +
        `M2-g 冷索引 fallback→tree-sitter WASM 符号→FTS5 跑通；` +
        `M2-h 75% 预算→持久摘要→近期原文→重开复用跑通；` +
        `M2-i 独立 session/seq→只读探索→结论回传→完整收尾跑通；` +
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

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
