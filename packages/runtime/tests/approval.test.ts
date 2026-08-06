import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PersistedEvent, PolicyRule, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryBlobStore, MemoryEventStore, ToolRegistry, composeRules } from '@xm/kernel';
import type { PermissionAnswer } from '@xm/runtime';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn } from '@xm/runtime';
import { coreTools, nodeCheckpointer, nodeToolGateway } from '@xm/tools-core';

/**
 * ── 权限闸门第一次跑在真实输入上（M1-c）──
 *
 * 在这个文件之前，闸门只被喂过用例里手写的字符串。这里喂给它的是**真实文件工具在
 * 真实临时目录上的真实入参**——路径由网关 realpath 出来，写入由 fs.write 真的落盘。
 *
 * 三件此前"实现存在、调用点不存在"的东西在这里第一次被端到端验证：
 * 会话/永久授权、结果截断、写前还原点。
 */

let dir: string;
let ENV: PolicyEnv;

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

const call = (name: string, args: unknown) => {
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

interface HarnessOptions {
  readonly answers?: PermissionAnswer[];
  readonly userRules?: PolicyRuleSet;
  readonly withBlobs?: boolean;
  readonly withCheckpoints?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  for (const t of coreTools()) tools.register(t);

  const blobs = new MemoryBlobStore(sha256);
  const asked: PermissionRequest[] = [];
  const persisted: PolicyRule[] = [];
  const answers = [...(options.answers ?? [])];

  const deps = {
    runtime,
    tools,
    layers: composeRules({ env: ENV, user: options.userRules ?? [] }),
    tier: 'balanced' as const,
    model: 'scripted-1',
    gateway: nodeToolGateway(),
    ...(options.withCheckpoints === true ? { checkpointer: nodeCheckpointer({ blobs }) } : {}),
    ...(options.withBlobs === true ? { blobs } : {}),
    decide: (request: PermissionRequest): Promise<PermissionAnswer> => {
      asked.push(request);
      return Promise.resolve(answers.shift() ?? { effect: 'deny', scope: 'once' });
    },
    persistGrant: (rule: PolicyRule): Promise<void> => {
      persisted.push(rule);
      return Promise.resolve();
    },
  };

  const turn = (text: string, ...calls: { chunks: unknown }[]): Promise<unknown> =>
    runTurn({ ...deps, provider: new ScriptedProvider({ turns: [...calls, END] as never }) }, text);

  return { store, sessionId, runtime, turn, asked, persisted, blobs };
}

const events = async (h: { store: MemoryEventStore; sessionId: ReturnType<typeof newSessionId> }) => {
  const out: PersistedEvent[] = [];
  for await (const e of h.store.read(h.sessionId)) out.push(e);
  return out;
};

const ended = (all: PersistedEvent[]) => all.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
const requests = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.request' ? [e.payload] : []));
const decisions = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.decision' ? [e.payload] : []));

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'xm-approval-')));
  ENV = { home: '/home/ming', appRoot: '/repo', dataDir: join(dir, '.data') };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('审批的三个范围', () => {
  const write = (name: string, content = 'hi') => call('fs.write', { path: name, content });

  it('本次允许：这一次放行，下一次照样问', async () => {
    const h = await harness({
      answers: [
        { effect: 'allow', scope: 'once' },
        { effect: 'allow', scope: 'once' },
      ],
    });
    await h.turn('写两个文件', write('a.md'), write('b.md'));

    expect(h.asked).toHaveLength(2);
    expect(ended(await events(h)).every((e) => e.ok)).toBe(true);
  });

  it('🔴 本会话允许：同一个目标第二次不再问', async () => {
    const h = await harness({ answers: [{ effect: 'allow', scope: 'session' }] });
    await h.turn('写两次同一个文件', write('a.md', '一'), write('a.md', '二'));

    // 只被问了一次，而两次调用都跑成功了
    expect(h.asked).toHaveLength(1);
    const all = await events(h);
    expect(requests(all)).toHaveLength(1);
    expect(ended(all)).toHaveLength(2);
    expect(ended(all).every((e) => e.ok)).toBe(true);
  });

  it('本会话的授权只覆盖那一个目标 —— 换个文件仍然要问', async () => {
    const h = await harness({
      answers: [
        { effect: 'allow', scope: 'session' },
        { effect: 'allow', scope: 'once' },
      ],
    });
    await h.turn('写两个不同文件', write('a.md'), write('b.md'));
    expect(h.asked).toHaveLength(2);
  });

  it('本会话拒绝：第二次直接被拒，不再打扰用户', async () => {
    const h = await harness({ answers: [{ effect: 'deny', scope: 'session' }] });
    await h.turn('写两次', write('a.md'), write('a.md'));

    expect(h.asked).toHaveLength(1);
    const all = await events(h);
    expect(ended(all).every((e) => !e.ok)).toBe(true);
    // 第二次是策略直接拒的，by 记 policy 而不是 user
    expect(decisions(all).at(-1)?.by).toBe('policy');
  });

  it('🔴 永久允许：合成出的规则被交去落盘，且与会话层用的是同一条', async () => {
    const h = await harness({ answers: [{ effect: 'allow', scope: 'always' }] });
    await h.turn('写一个', write('a.md'));

    expect(h.persisted).toHaveLength(1);
    const rule = h.persisted[0]!;
    expect(rule.effect).toBe('allow');
    expect(rule.capability).toBe('fs.write');
    expect(rule.match?.target).toBe(join(dir, 'a.md'));
    expect(rule.id).toMatch(/^grant\.always\./);
  });

  /**
   * 🔴 判定与执行必须用**同一个**路径。
   *
   * 只把 target 算出来、却不把解析后的入参回写给工具，是一个看起来无害的省略：
   * 权限判定是对的，日志也是对的。而工具拿到的仍是模型给的相对路径，
   * 于是它按**进程的 cwd** 解析——文件落在小明自己的安装目录里，
   * 而判定放行的是工作区里的那个路径。这就是权限判定上的 TOCTOU，
   * 只不过 T 和 O 之间隔的不是时间，是两个不同的值。
   */
  it('🔴 模型给相对路径时，文件落在会话的工作区里，而不是进程的 cwd', async () => {
    // 名字每次都不同：这条用例的反面断言查的是"进程 cwd 下没有这个文件"，
    // 固定名字会被上一次失败留下的残骸影响
    const name = `landed-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.md`;
    const h = await harness({ answers: [{ effect: 'allow', scope: 'once' }] });
    await h.turn('写一个', write(name, '内容'));

    expect(await readFile(join(dir, name), 'utf8')).toBe('内容');
    // 反面：进程 cwd 下不该冒出这个文件
    await expect(readFile(join(process.cwd(), name), 'utf8')).rejects.toThrow();
  });

  it('🔴 决定的 scope 如实落库 —— 它是 grants 唯一的来源', async () => {
    const h = await harness({ answers: [{ effect: 'allow', scope: 'session' }] });
    await h.turn('写一个', write('a.md'));

    expect(decisions(await events(h))[0]?.scope).toBe('session');
    expect(h.runtime.state.grants).toHaveLength(1);
  });

  it('没有应答者 = 拒绝 —— headless 下没人能点允许，默认放行就是没有闸门', async () => {
    const h = await harness({ answers: [] });
    await h.turn('写一个', write('a.md'));
    expect(ended(await events(h)).every((e) => !e.ok)).toBe(true);
  });
});

describe('🔴 红线在真实工具输入下被验证一次', () => {
  it('模型给一个指向敏感文件的符号链接，判定落在链接指向的地方', async () => {
    const secret = join(dir, 'outside-secret');
    await writeFile(secret, 'PRIVATE');
    await symlink(secret, join(dir, 'notes.txt'));

    const h = await harness({
      answers: [{ effect: 'allow', scope: 'once' }],
      userRules: [
        {
          id: 'user.no-secret',
          effect: 'deny',
          capability: 'fs.read',
          match: { target: secret },
          reason: '这个文件不许读',
          immutable: false,
        },
      ],
    });

    await h.turn('读一下笔记', call('fs.read', { path: 'notes.txt' }));

    const all = await events(h);
    // 规则写的是真实文件，模型给的是链接名 —— 没有网关的话这条规则完全匹配不上
    expect(requests(all)[0]?.target).toBe(secret);
    expect(decisions(all)[0]?.effect).toBe('deny');
    expect(ended(all)[0]?.ok).toBe(false);
  });

  it('自改红线拦得住一个普通写文件工具 —— 它声明的是 fs.write，不是 self.modify', async () => {
    // 把临时目录当成小明自己的安装目录，红线于是落在这里面
    ENV = { home: '/home/ming', appRoot: dir, dataDir: join(dir, '.data') };
    const h = await harness({ answers: [{ effect: 'allow', scope: 'once' }] });

    await h.turn('改一下扫描脚本', call('fs.write', { path: 'scripts/check-secrets.mjs', content: 'x' }));

    const all = await events(h);
    expect(decisions(all)[0]?.effect).toBe('deny');
    expect(decisions(all)[0]?.ruleId).toMatch(/^red\.self-modify-/);
    // 用户根本没被问 —— 红线不是一个可以点"允许"的确认框
    expect(h.asked).toHaveLength(0);
  });
});

describe('🔴 结果截断接上了', () => {
  it('大文件的结果被截断，全文进 blob，标记对模型可见', async () => {
    // fs.read 的默认结果上限是 64 KB
    await writeFile(join(dir, 'big.txt'), `${'y'.repeat(80)}\n`.repeat(2000));

    const h = await harness({ withBlobs: true });
    await h.turn('读它', call('fs.read', { path: 'big.txt' }));

    const end = ended(await events(h))[0]!;
    const text = end.forModel.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text.length).toBeLessThan(80 * 1024);
    expect(text).toContain('已省略');
    expect(end.fullRef).toBeDefined();
    expect(await h.blobs.stat(end.fullRef!)).toBeDefined();
  });

  it('小结果不截断，也不写 blob', async () => {
    await writeFile(join(dir, 'small.txt'), 'hi\n');
    const h = await harness({ withBlobs: true });
    await h.turn('读它', call('fs.read', { path: 'small.txt' }));
    expect(ended(await events(h))[0]?.fullRef).toBeUndefined();
  });
});

describe('🔴 写前还原点接上了', () => {
  it('覆盖之前落一条 checkpoint.created，且它排在 tool.start 之前', async () => {
    await writeFile(join(dir, 'a.md'), 'OLD');
    const h = await harness({
      answers: [{ effect: 'allow', scope: 'once' }],
      withCheckpoints: true,
    });
    await h.turn('改它', call('fs.write', { path: 'a.md', content: 'NEW' }));

    const all = await events(h);
    const types = all.map((e) => e.type);
    expect(types).toContain('checkpoint.created');
    expect(types.indexOf('checkpoint.created')).toBeLessThan(types.indexOf('tool.start'));

    const cp = all.find((e) => e.type === 'checkpoint.created');
    expect(cp?.type === 'checkpoint.created' && cp.payload.kind).toBe('fs');
    // 还原点进了状态，重开会话看得见
    expect(h.runtime.state.checkpoints).toHaveLength(1);
  });

  it('只读工具不建还原点 —— 还原点列表里全是噪音时，真正能回退的那几个反而找不到', async () => {
    await writeFile(join(dir, 'a.md'), 'x');
    const h = await harness({ withCheckpoints: true });
    await h.turn('读它', call('fs.read', { path: 'a.md' }));
    expect((await events(h)).map((e) => e.type)).not.toContain('checkpoint.created');
  });
});

describe('🔴 挂起的审批不许把回合卡死', () => {
  it('中断时兑现成拒绝 —— 应答者永远不回答也一样', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
    });

    const tools = new ToolRegistry();
    for (const t of coreTools()) tools.register(t);
    const controller = new AbortController();

    const done = runTurn(
      {
        runtime,
        provider: new ScriptedProvider({
          turns: [call('fs.write', { path: 'a.md', content: 'x' }), END] as never,
        }),
        tools,
        layers: composeRules({ env: ENV }),
        tier: 'balanced',
        model: 'scripted-1',
        gateway: nodeToolGateway(),
        signal: controller.signal,
        // 一个永远不回答的应答者。没有那道保险的话，这个 promise 会挂到天荒地老
        decide: () => new Promise<PermissionAnswer>(() => undefined),
      },
      '写一个',
    );

    // 等审批请求落库之后再中断
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    await expect(done).resolves.toBeDefined();
    const all: PersistedEvent[] = [];
    for await (const e of store.read(sessionId)) all.push(e);
    expect(decisions(all)[0]?.effect).toBe('deny');
    await runtime.close();
  });

  it('应答者自己抛错 → 按拒绝处理，绝不因为"审批出错"就放行', async () => {
    // harness 的 decide 在答案用完时返回 deny；这里换一个直接抛的
    const h = await harness();
    const runtime = h.runtime;
    const tools = new ToolRegistry();
    for (const t of coreTools()) tools.register(t);

    await runTurn(
      {
        runtime,
        provider: new ScriptedProvider({
          turns: [call('fs.write', { path: 'b.md', content: 'x' }), END] as never,
        }),
        tools,
        layers: composeRules({ env: ENV }),
        tier: 'balanced',
        model: 'scripted-1',
        gateway: nodeToolGateway(),
        decide: () => Promise.reject(new Error('UI 崩了')),
      },
      '写一个',
    );

    expect(decisions(await events(h)).at(-1)?.effect).toBe('deny');
  });
});

describe('网关失败关闭', () => {
  it('解析不了的路径不执行，也不惊动用户', async () => {
    const h = await harness({ answers: [{ effect: 'allow', scope: 'once' }] });
    // 入参类型不对：网关拒绝，不该产生任何权限事件
    await h.turn('乱写', call('fs.write', { path: '', content: 'x' }));

    const all = await events(h);
    expect(requests(all)).toHaveLength(0);
    expect(ended(all)[0]?.ok).toBe(false);
    expect(h.asked).toHaveLength(0);
  });
});

async function sha256(data: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}
