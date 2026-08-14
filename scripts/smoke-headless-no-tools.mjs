import { MemoryEventStore, ToolRegistry, builtinLayers, policyEnvFromPaths } from '../packages/kernel/dist/index.js';
import { builtinProfile, withoutBuiltinTools } from '../packages/compose/dist/index.js';
import { newSessionId } from '../packages/contracts/dist/index.js';
import { nodePlatform } from '../packages/platform/dist/index.js';
import { createLocalExecutionWorld, nodeToolGateway } from '../packages/tool-runtime/dist/index.js';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  runTurn,
  textInput,
} from '../packages/runtime/dist/index.js';

const profile = withoutBuiltinTools(builtinProfile('headless'));
if (profile.rows.some((row) => row.id === 'tools.builtin')) {
  throw new Error('无工具 profile 仍包含 tools.builtin');
}

const platform = nodePlatform({ appRoot: process.cwd(), dataDir: process.cwd() });
const paths = platform.paths();
const runtime = await SessionRuntime.open({
  sessionId: newSessionId(),
  store: new MemoryEventStore(),
  bus: new EventBus(),
});
await runtime.record({
  type: 'session.created',
  payload: { cwd: paths.home, modelRef: 'scripted/scripted-1', title: 'no-tools smoke' },
});

const tools = new ToolRegistry();
const provider = new ScriptedProvider({
  turns: [{ chunks: [
    { kind: 'text_delta', text: '空工具世界正常。' },
    { kind: 'stop', reason: 'end_turn' },
  ] }],
});
const reason = await runTurn({
  runtime,
  executor: createLocalExecutionWorld(),
  provider,
  tools,
  layers: builtinLayers(policyEnvFromPaths(paths)),
  model: 'scripted-1',
  gateway: nodeToolGateway({ home: paths.home }),
  pathCaseInsensitive: platform.os === 'windows',
}, textInput('在没有业务工具时回答一句话'));

if (reason !== 'end_turn' || tools.descriptors().length !== 0) {
  throw new Error('无工具 headless 冒烟未得到预期结果');
}
await runtime.close();
console.log('✓ headless no-tools smoke：空工具 profile 完成一轮对话');
