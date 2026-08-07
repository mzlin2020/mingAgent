import { realpath as realpathCb } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PersistedEvent, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryEventStore, ToolRegistry, composeRules } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn } from '@xm/runtime';
import { coreTools, nodeToolGateway } from '@xm/tools-core';

/**
 * ── 命令即一组能力主张，跑在真实工具上（ADR-0026）──
 *
 * 内核那边（command-claims.test.ts）证明的是"一条命令拆得对"。
 * 这里证明的是唯一真正要紧的那件事：
 *
 *   **真实的 `shell.exec` 工具、真实的网关、真实的规则，`rm -rf ~` 到不了 spawn。**
 *
 * 两者缺一不可。拆得对但闸门没按拆出来的主张判，就又是一次
 * "规则存在 ≠ 规则生效"——而这一次它会长成"测试全绿、家目录没了"。
 */

let dir: string;
let home: string;
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

  const exec = async (argv: string[]): Promise<PersistedEvent[]> => {
    await runTurn(
      {
        runtime,
        tools,
        layers: composeRules({ env: ENV, user: userRules }),
        tier: 'balanced' as const,
        model: 'scripted-1',
        gateway: nodeToolGateway({ home }),
        provider: new ScriptedProvider({ turns: [call('shell.exec', { argv }), END] as never }),
        // 永远点"允许"：于是任何一次放行都必须是 deny 没拦住，
        // 不能是"这个用例恰好没人点允许"
        decide: (request: PermissionRequest) => {
          asked.push(request);
          return Promise.resolve({ effect: 'allow' as const, scope: 'once' as const });
        },
      },
      '跑一下',
    );
    const out: PersistedEvent[] = [];
    for await (const e of store.read(sessionId)) out.push(e);
    return out;
  };

  return { exec, asked };
}

const ended = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
const decisions = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.decision' ? [e.payload] : []));
const started = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.start' ? [e.payload] : []));

beforeEach(async () => {
  const realNative = promisify(realpathCb.native);
  dir = await realNative(await mkdtemp(join(tmpdir(), 'xm-shell-claims-')));
  home = await realNative(await mkdtemp(join(tmpdir(), 'xm-shell-home-')));
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_rsa'), 'PRIVATE\n');
  await writeFile(join(dir, 'ok.txt'), 'fine\n');
  ENV = { home, appRoot: '/repo', dataDir: join(home, '.xiaoming') };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('🔴 M1-d DoD：rm -rf ~ 被拦，而且四种写法判定一致', () => {
  it.each([
    ['朴素', ['rm', '-rf', '~']],
    ['绝对路径的 bin', ['/bin/rm', '-rf', '~']],
    ['sh -c 包一层', ['sh', '-c', 'rm -rf ~']],
    ['env 包一层', ['env', 'FOO=1', 'rm', '-rf', '~']],
    // 藏在连接符后面：只判第一段的实现在这里露头，而它在解析器那层看不出来
    ['分号后面藏一段', ['sh', '-c', 'echo ok; rm -rf ~']],
    ['&& 后面藏一段', ['sh', '-c', 'echo ok && rm -rf ~']],
    ['管道后面藏一段', ['sh', '-c', 'echo ok | grep ok; rm -rf ~']],
  ])('%s → deny，且命中同一条红线', async (_label, argv) => {
    const { exec, asked } = await harness();
    const all = await exec(argv);

    expect(ended(all)[0]?.ok).toBe(false);
    const denied = decisions(all).filter((d) => d.effect === 'deny');
    expect(denied[0]?.ruleId).toBe('red.fs-delete-home-root');
    // **一个确认框都没弹**：判完全部主张才问人，而这次判完就已经 deny 了
    expect(asked).toHaveLength(0);
  });

  it('🔴 `rm -rf /` 同样被拦 —— 命中的是文件系统根那条', async () => {
    const { exec } = await harness();
    const all = await exec(['rm', '-rf', '/']);
    /*
     * 命中哪一条红线**随平台而变，这是应该的**：POSIX 写法的 `/` 经网关按会话
     * cwd 解析后，在 POSIX 上落在 `/`，在 Windows 上落在当前盘符根（`C:/`）——
     * 两个坐标系下的"文件系统根"本来就不是同一个字符串，各自的红线各管各的
     * （ADR-0026 补记）。这条用例要证明的是"总有一条红线接住"，不是"是哪一条"。
     */
    expect(decisions(all)[0]?.ruleId).toMatch(/^red\.fs-delete-(filesystem|drive)-root$/);
  });

  it('🔴 家目录下的普通文件不受影响 —— 拦得太宽等于整条规则会被关掉', async () => {
    const { exec } = await harness();
    const all = await exec(['rm', '-rf', join(home, 'notes.txt')]);
    expect(ended(all)[0]?.ok).toBe(true);
  });
});

describe('🔴 已有的规则自动覆盖命令', () => {
  it('cat 私钥撞上 ADR-0025 的读取 deny —— 一条新规则都没写', async () => {
    const { exec } = await harness();
    const all = await exec(['cat', join(home, '.ssh', 'id_rsa')]);
    expect(ended(all)[0]?.ok).toBe(false);
    expect(decisions(all)[0]?.ruleId).toMatch(/^def\.no-read-/);
    expect(JSON.stringify(all)).not.toContain('PRIVATE');
  });

  it('往 .zshrc 追加撞上 ADR-0027 的写入 deny', async () => {
    const { exec } = await harness();
    /*
     * 这一段是 **shell 源码**，不是 argv 数组——`>>` 要能被 `parseShellSource` 认成
     * 重定向。词法器的转义规则和真实 shell 一致：反斜杠转义下一个字符。Windows 上
     * `join()` 产出反斜杠分隔的路径，直接拼进去会被逐个吃掉分隔符（真实 `sh` 面对
     * 反斜杠路径同样会这样解析，这不是我们的词法器特有的行为）。正斜杠在 Windows
     * 文件系统里同样合法，用它拼接才是这段 shell 源码该有的写法。
     */
    const target = join(home, '.zshrc').replace(/\\/g, '/');
    const all = await exec(['sh', '-c', `echo evil >> ${target}`]);
    expect(decisions(all)[0]?.ruleId).toBe('def.no-write-zshrc');
  });

  it('sudo 撞上内置的"判不了"deny', async () => {
    const { exec } = await harness();
    const all = await exec(['sudo', 'ls']);
    expect(decisions(all)[0]?.ruleId).toBe('def.no-exec-sudo-args');
  });
});

describe('🔴 curl 不再绕过不可信标记', () => {
  it('tool.start 记的是主张里的能力全集，于是 net.fetch 在里面', async () => {
    const { exec } = await harness([
      {
        id: 'user.allow-fetch',
        effect: 'allow',
        capability: 'net.fetch',
        match: { target: 'example.com' },
        reason: '用例放行，只为看能力有没有被记下来',
        immutable: false,
      },
    ]);
    const all = await exec(['curl', 'https://example.com/a']);
    expect(started(all)[0]?.capabilities).toContain('net.fetch');
  });
});

describe('放行的路径也要真的通', () => {
  it('普通命令问一次就跑起来了', async () => {
    const { exec, asked } = await harness();
    const all = await exec(['echo', 'hello-xm']);
    expect(ended(all)[0]?.ok).toBe(true);
    expect(JSON.stringify(ended(all)[0]?.forModel)).toContain('hello-xm');
    // 只有 shell.exec 一条主张要问
    expect(asked.map((a) => a.capability)).toEqual(['shell.exec']);
  });

  it('🔴 判不了的命令在网关就停了，不发权限事件 —— 确认框上写什么都是猜的', async () => {
    const { exec, asked } = await harness();
    const all = await exec(['sh', '-c', 'rm -rf $(cat target)']);
    expect(ended(all)[0]?.ok).toBe(false);
    expect(decisions(all)).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
});
