import { realpath as realpathCb } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PersistedEvent, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryEventStore, ToolRegistry, composeRules } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';
import { coreTools, nodeToolGateway } from '@xm/tools-core';

/**
 * ── 敏感路径的读取拒绝，跑在真实工具上（ADR-0025）──
 *
 * 内核那边（policy-sensitive-read.test.ts）证明的是"规则判得对"。
 * 这里证明的是另一件事，而它才是这批规则唯一的存在理由：
 *
 *   **真实的 `fs.read` 工具、真实的路径网关、真实的文件，私钥的内容一个字节
 *   都没有进事件流。**
 *
 * 两者缺一不可。规则判得对但工具走的是另一条路（比如判定看的是链接名、
 * 打开的是链接指向的文件），就是本项目记过很多次的那种"规则存在 ≠ 规则生效"。
 */

const SECRET = 'BEGIN-OPENSSH-PRIVATE-KEY-ffffffff';

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

async function harness(userRules: PolicyRuleSet = []) {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  for (const t of coreTools({ os: 'linux' })) tools.register(t);

  const asked: PermissionRequest[] = [];

  const read = async (path: string): Promise<PersistedEvent[]> => {
    await runTurn(
      {
        runtime,
        tools,
        layers: composeRules({ env: ENV, user: userRules }),
        tier: 'balanced' as const,
        model: 'scripted-1',
        gateway: nodeToolGateway(),
        provider: new ScriptedProvider({ turns: [call('fs.read', { path }), END] as never }),
        // 有人应答，而且永远点"允许" —— 于是任何一次放行都必须是 deny 没拦住，
        // 不能是"这个用例恰好没人点允许"
        decide: (request: PermissionRequest) => {
          asked.push(request);
          return Promise.resolve({ effect: 'allow' as const, scope: 'once' as const });
        },
      },
      textInput('读一下'),
    );
    const out: PersistedEvent[] = [];
    for await (const e of store.read(sessionId)) out.push(e);
    return out;
  };

  return { read, asked };
}

const ended = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
const decisions = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.decision' ? [e.payload] : []));

/** Windows 的 %TEMP% 是 8.3 短名，macOS 的 /tmp 是符号链接 —— 两边都得先解析成真名 */
const realNative = promisify(realpathCb.native);

beforeEach(async () => {
  dir = await realNative(await mkdtemp(join(tmpdir(), 'xm-sensitive-')));
  // 把临时目录当成用户的家目录：敏感路径的规则全部相对它计算
  ENV = { home: dir, appRoot: '/repo', dataDir: join(dir, '.xiaoming') };
  await mkdir(join(dir, '.ssh'), { recursive: true });
  await writeFile(join(dir, '.ssh', 'id_rsa'), SECRET);
  await writeFile(join(dir, '.env'), `API_KEY=${SECRET}`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 私钥有没有从任何一条事件里漏出去 —— 这是整个文件真正在断言的东西 */
const leaked = (all: PersistedEvent[]): boolean => JSON.stringify(all).includes(SECRET);

describe('🔴 私钥读不出来', () => {
  it('直接读 ~/.ssh/id_rsa：拒绝，且内容没进事件流', async () => {
    const h = await harness();
    const all = await h.read(join(dir, '.ssh', 'id_rsa'));

    expect(decisions(all)[0]?.effect).toBe('deny');
    // `~/.ssh/**` 与 `**/id_rsa*` 两条都盖着它，命中哪条不重要，是这批规则就行
    expect(decisions(all)[0]?.ruleId).toMatch(/^def\.no-read-/);
    expect(ended(all)[0]?.ok).toBe(false);
    expect(leaked(all)).toBe(false);
    // deny 不是一个可以点"允许"的确认框 —— 用户根本没被问
    expect(h.asked).toHaveLength(0);
  });

  /**
   * 注入攻击的标准形状：让模型读一个名字人畜无害的文件，而那个名字是个符号链接。
   * 判定必须落在链接**指向**的地方——这一条靠的是 ADR-0024 的网关，
   * 而这里验的是"网关 + 这批新规则"合起来仍然成立。
   */
  it('🔴 工作区里一个指向私钥的符号链接：同样拒绝', async () => {
    await symlink(join(dir, '.ssh', 'id_rsa'), join(dir, 'notes.txt'));
    const h = await harness();
    const all = await h.read('notes.txt');

    expect(decisions(all)[0]?.effect).toBe('deny');
    expect(ended(all)[0]?.ok).toBe(false);
    expect(leaked(all)).toBe(false);
  });

  it('列目录也拦得住 —— fs.list 声明的同样是 fs.read', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
    });
    const tools = new ToolRegistry();
    for (const t of coreTools({ os: 'linux' })) tools.register(t);

    await runTurn(
      {
        runtime,
        tools,
        layers: composeRules({ env: ENV }),
        tier: 'balanced' as const,
        model: 'scripted-1',
        gateway: nodeToolGateway(),
        provider: new ScriptedProvider({
          turns: [call('fs.list', { path: join(dir, '.ssh') }), END] as never,
        }),
        decide: () => Promise.resolve({ effect: 'allow' as const, scope: 'once' as const }),
      },
      textInput('看看这个目录'),
    );

    const all: PersistedEvent[] = [];
    for await (const e of store.read(sessionId)) all.push(e);
    expect(decisions(all)[0]?.effect).toBe('deny');
    expect(ended(all)[0]?.ok).toBe(false);
  });
});

describe('🔴 .env 读不出来，但用户能放开', () => {
  it('工作区里的 .env：拒绝，内容没进事件流', async () => {
    const h = await harness();
    const all = await h.read('.env');

    expect(decisions(all)[0]?.effect).toBe('deny');
    expect(decisions(all)[0]?.ruleId).toBe('def.no-read-dotenv');
    expect(leaked(all)).toBe(false);
  });

  it('用户在配置里对它写一条 allow，就真的读得到', async () => {
    const h = await harness([
      {
        id: 'user.allow-this-env',
        effect: 'allow',
        capability: 'fs.read',
        match: { target: `${dir.replace(/\\/g, '/')}/.env` },
        reason: '这个 .env 我要它能看',
        immutable: false,
      },
    ]);
    const all = await h.read('.env');

    expect(ended(all)[0]?.ok).toBe(true);
    // 这一条是反着断言的：用户显式放开之后，内容**应该**进得来
    expect(leaked(all)).toBe(true);
  });
});

describe('没有误伤', () => {
  it('普通文件照读不误', async () => {
    await writeFile(join(dir, 'README.md'), '# hi');
    const h = await harness();
    const all = await h.read('README.md');

    expect(ended(all)[0]?.ok).toBe(true);
    expect(decisions(all)).toHaveLength(0);
  });
});
