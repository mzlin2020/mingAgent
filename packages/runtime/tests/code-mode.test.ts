import { realpath as realpathCb } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryEventStore, ToolRegistry, builtinLayers, deriveTraces } from '@xm/kernel';
import { createQuickJsCodeRuntime } from '@xm/code-runtime';
import { localExecutionWorld, nodeToolGateway } from '@xm/tool-runtime';
import { coreTools } from '@xm/tools-core';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  runCodeTool,
  runTurn,
  textInput,
} from '@xm/runtime';

/**
 * Code Mode 走完整条链（ADR-0061 / ADR-0069 / ADR-0072）。
 *
 * 这里的每一条都跑在**真实的东西**上：真的 QuickJS 客体域、真的 `coreTools`、
 * 真的路径网关、真的红线规则、真的文件。用假工具能验的东西，
 * 恰好绕开这一段最容易出错的地方——判定与执行落在两个不同的路径上。
 *
 * ADR-0061 §后果 列的六条反向演练在这里逐条兑现（第 3 条"死循环/OOM"在
 * `packages/code-runtime/tests/quickjs.test.ts`，那是提供者自己的事）。
 */

const SECRET = 'BEGIN-OPENSSH-PRIVATE-KEY-仅在私钥里出现';
const FILE_MARK = '只在文件正文里出现的哨兵-7b21';

const runtime = createQuickJsCodeRuntime({ budget: { wallClockMs: 10_000 } });
afterAll(async () => {
  await runtime.dispose();
});

let dir: string;
let env: PolicyEnv;
const realNative = promisify(realpathCb.native);

beforeEach(async () => {
  dir = await realNative(await mkdtemp(join(tmpdir(), 'xm-code-')));
  env = {
    home: dir,
    appRoot: '/repo',
    dataDir: join(dir, '.xiaoming'),
    configDir: join(dir, '.config'),
  };
  await mkdir(join(dir, '.ssh'), { recursive: true });
  await writeFile(join(dir, '.ssh', 'id_rsa'), SECRET, 'utf8');
  await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(join(dir, name), `${name} 的内容 ${FILE_MARK}\n`, 'utf8');
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

const callTurn = (name: string, args: unknown) => {
  const id = newCallId();
  return {
    chunks: [
      { kind: 'tool_call_start' as const, id, name },
      { kind: 'tool_call_delta' as const, id, argsJson: JSON.stringify(args) },
      { kind: 'tool_call_end' as const, id },
      { kind: 'stop' as const, reason: 'tool_use' as const },
    ],
  };
};

/** 跑一个回合，模型只发一次工具调用，然后结束 */
async function once(
  turns: readonly { readonly chunks: unknown }[],
  options: { readonly withCodeRuntime?: boolean } = {},
): Promise<{ events: PersistedEvent[]; provider: ScriptedProvider }> {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const session = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await session.record({
    type: 'session.created',
    payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  for (const tool of coreTools({ os: 'linux', tempDir: tmpdir() })) tools.register(tool);
  tools.register(runCodeTool());

  const provider = new ScriptedProvider({ turns: turns as never });
  await runTurn(
    {
      runtime: session,
      executor: localExecutionWorld,
      tools,
      layers: builtinLayers(env),
      model: 'scripted-1',
      gateway: nodeToolGateway(),
      provider,
      toolPresentation: 'both',
      ...(options.withCodeRuntime === false ? {} : { codeRuntime: runtime }),
    },
    textInput('干活'),
  );
  await session.close();

  const events: PersistedEvent[] = [];
  for await (const event of store.read(sessionId)) events.push(event);
  return { events, provider };
}

const program = (source: string) => callTurn('run_code', { source });

const dispatches = (events: readonly PersistedEvent[]) =>
  events.flatMap((event) => (event.type === 'tool.code.dispatch' ? [event.payload] : []));
const toolEnds = (events: readonly PersistedEvent[]) =>
  events.flatMap((event) => (event.type === 'tool.end' ? [event.payload] : []));
const modelText = (events: readonly PersistedEvent[]) =>
  toolEnds(events)
    .flatMap((end) => end.forModel)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');

describe('M3-h 验收：一段程序连调三个工具', () => {
  it('三次工具调用只用一次模型往返，且只有一次 tool.start / tool.end', async () => {
    const { events, provider } = await once([
      program(
        `const names = ['a.txt', 'b.txt', 'c.txt'];
         let total = 0;
         for (const name of names) { total += xm.fs.read({ path: name }).lineCount; }
         return { files: names.length, lines: total };`,
      ),
      END,
    ]);

    // 原生形态下这是三次 tool_use 往返 + 一次收尾 = 4 次模型请求；这里是 2 次
    expect(provider.requests).toHaveLength(2);
    expect(dispatches(events)).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tool.start')).toHaveLength(1);
    expect(toolEnds(events)).toHaveLength(1);
    expect(toolEnds(events)[0]?.ok).toBe(true);
    expect(modelText(events)).toContain('"files":3');
  });

  /**
   * 🔴 **程序的中间值不进模型请求，也不进事件流**（ADR-0061 §四）。
   *
   * 这是 Code Mode 省往返的前提，也是最容易被"顺手改好"的一条：
   * 给 `tool.code.dispatch` 加一个 `forModel` 字段就能"让审计更完整"，
   * 而那一改会把三份文件正文塞回每一次后续模型请求。
   *
   * 断言按整份事件流搜哨兵写，不按字段名写——后者换个名字就绕过去了。
   */
  it('🔴 三份文件正文都没进事件流，只有程序归纳出来的那一句进了', async () => {
    const { events } = await once([
      program(
        `let n = 0;
         for (const name of ['a.txt', 'b.txt', 'c.txt']) { n += xm.fs.read({ path: name }).lineCount; }
         return '一共 ' + n + ' 行';`,
      ),
      END,
    ]);
    expect(JSON.stringify(events)).not.toContain(FILE_MARK);
    // 反过来确认这条断言不是因为"事件流本来就是空的"而通过的
    expect(modelText(events)).toContain('一共 3 行');
    expect(dispatches(events)).toHaveLength(3);
  });
});

describe('🔴 反向演练一 / 五：程序里撞红线', () => {
  it('程序写 git 钩子：被拒，理由与直接调用一模一样', async () => {
    const args = { path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl evil' };
    const direct = await once([callTurn('fs.write', args), END]);
    const viaCode = await once([
      program(`return xm.fs.write(${JSON.stringify(args)});`),
      END,
    ]);

    const denied = dispatches(viaCode.events)[0];
    expect(denied?.ok).toBe(false);
    expect(denied?.error?.code).toBe('policy_denied');
    // 与直接调用同一句话。理由漂了，就等于程序里的红线是另一套（ADR-0061 §一）
    expect(denied?.error?.message).toBe(toolEnds(direct.events)[0]?.error?.message);
    expect(toolEnds(direct.events)[0]?.error?.code).toBe('policy_denied');
  });

  it('🔴 父 run_code 放行 ≠ 子 fs.write 放行：父成功、子被拒', async () => {
    const { events } = await once([
      program(
        `try { xm.fs.write({ path: '.git/hooks/pre-commit', content: 'x' }); return '写进去了'; }
         catch (e) { return '被拒：' + e.code; }`,
      ),
      END,
    ]);
    expect(toolEnds(events)[0]?.ok).toBe(true); // 父调用本身成功
    expect(dispatches(events)[0]?.ok).toBe(false); // 子调用被拒
    expect(modelText(events)).toContain('被拒：policy_denied');
  });

  it('🔴 反向演练六：程序 catch 掉拒绝继续跑，审计里仍有那条 dispatch', async () => {
    const { events } = await once([
      program(
        `let denied = 0;
         try { xm.fs.read({ path: '.ssh/id_rsa' }); } catch (e) { denied++; }
         const ok = xm.fs.read({ path: 'a.txt' });
         return { denied: denied, then: ok.kind };`,
      ),
      END,
    ]);
    const log = dispatches(events);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ index: 0, name: 'fs.read', ok: false });
    expect(log[1]).toMatchObject({ index: 1, name: 'fs.read', ok: true });
    // 程序把它吞了，模型看到的是"一切正常"，但事件流里那次拒绝还在
    expect(modelText(events)).toContain('"denied":1');
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('🔴 反向演练二：程序用符号链接绕私钥，网关照常解析后拒绝', async () => {
    try {
      await symlink(join(dir, '.ssh', 'id_rsa'), join(dir, 'notes.txt'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const { events } = await once([
      program(`try { return xm.fs.read({ path: 'notes.txt' }); } catch (e) { return 'X:' + e.code; }`),
      END,
    ]);
    const denied = dispatches(events)[0];
    expect(denied?.ok).toBe(false);
    // 判定看到的是解析后的真路径，不是 notes.txt（ADR-0024 的网关回写）
    expect(denied?.input).toMatchObject({ path: join(dir, '.ssh', 'id_rsa') });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe('🔴 反向演练四：程序拿不到宿主能力', () => {
  it('require / process / fetch / Function 构造器全部拿不到，经 ctx.codeMode 再验一遍', async () => {
    const { events } = await once([
      program(
        `var v = {};
         try { require('node:fs'); v.require = '拿到了'; } catch (e) { v.require = '拿不到'; }
         v.process = typeof process === 'undefined' ? '拿不到' : '拿到了';
         v.fetch = typeof fetch === 'undefined' ? '拿不到' : '拿到了';
         try { Function('return process')(); v.fn = '拿到了'; } catch (e) { v.fn = '拿不到'; }
         return v;`,
      ),
      END,
    ]);
    const text = modelText(events);
    expect(text).toContain('"require":"拿不到"');
    expect(text).toContain('"process":"拿不到"');
    expect(text).toContain('"fetch":"拿不到"');
    expect(text).toContain('"fn":"拿不到"');
  });
});

describe('Code Mode 的边界', () => {
  it('不做嵌套：run_code 不在绑定里，硬调也只得到"没有这个工具"', async () => {
    const { events } = await once([
      program(
        `const has = typeof xm.run_code;
         let inner = '没试';
         try { xm.run_code({ source: 'return 1;' }); inner = '跑了'; }
         catch (e) { inner = e.message; }
         return { has: has, inner: inner };`,
      ),
      END,
    ]);
    expect(modelText(events)).toContain('"has":"undefined"');
    expect(dispatches(events)).toHaveLength(0); // 连一次派发都没发生：绑定压根不存在
  });

  it('没装运行时：run_code 老实说自己不可用，不假装跑过', async () => {
    const { events } = await once([program(`return 1;`), END], { withCodeRuntime: false });
    expect(toolEnds(events)[0]?.ok).toBe(true);
    expect(modelText(events)).toContain('没有装配 Code Mode 运行时');
    expect(dispatches(events)).toHaveLength(0);
  });

  /**
   * 派生 trace 要看得见程序里的每一步，而且要**分得清**它们不是模型发的
   * （ADR-0072 §后果）。评测靠这个数字回答"这次任务花了几次模型往返"——
   * 十次子调用只花一次往返，混成一样那个数字就读不出来了。
   */
  it('派生 trace 把子调用记成 viaCode 步骤，不与模型直发的混为一谈', async () => {
    const { events } = await once([
      program(`xm.fs.read({ path: 'a.txt' }); xm.fs.read({ path: 'b.txt' }); return 'ok';`),
      END,
    ]);
    const steps = deriveTraces(events)[0]?.steps ?? [];
    expect(steps.map((step) => [step.name, step.viaCode !== undefined])).toEqual([
      ['fs.read', true],
      ['fs.read', true],
      ['run_code', false],
    ]);
  });

  it('子调用带着父 callId 与顺序号，审计能还原"这是程序里的第几步"', async () => {
    const { events } = await once([
      program(`xm.fs.read({ path: 'a.txt' }); xm.fs.list({ path: '.' }); return 'done';`),
      END,
    ]);
    const parent = events.find((event) => event.type === 'tool.start');
    const parentCallId = parent?.type === 'tool.start' ? parent.payload.callId : undefined;
    expect(dispatches(events).map((item) => item.parentCallId)).toEqual([
      parentCallId,
      parentCallId,
    ]);
    expect(dispatches(events).map((item) => [item.index, item.name])).toEqual([
      [0, 'fs.read'],
      [1, 'fs.list'],
    ]);
    // 子调用有自己的 callId，不是父的
    expect(dispatches(events)[0]?.callId).not.toBe(parentCallId);
  });
});
