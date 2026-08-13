import { realpath as realpathCb } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedEvent, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryBlobStore, MemoryEventStore, ToolRegistry, composeRules } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';
import { coreTools, nodeCheckpointer, nodeToolGateway } from '@xm/tools-core';

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
  const blobs = new MemoryBlobStore(sha256);
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: dir, modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  for (const t of coreTools({ os: 'linux' })) tools.register(t);

  const exec = async (argv: string[]): Promise<PersistedEvent[]> => {
    await runTurn(
      {
        runtime,
        tools,
        layers: composeRules({ env: ENV, user: userRules }),
        model: 'scripted-1',
        gateway: nodeToolGateway({ home }),
        checkpointer: nodeCheckpointer({ blobs }),
        provider: new ScriptedProvider({ turns: [call('shell.exec', { argv }), END] as never }),
      },
      textInput('跑一下'),
    );
    const out: PersistedEvent[] = [];
    for await (const e of store.read(sessionId)) out.push(e);
    return out;
  };

  return { exec };
}

const ended = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
const decisions = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.decision' ? [e.payload] : []));
const started = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'tool.start' ? [e.payload] : []));
/** ADR-0039：`permission.request` 只在**拒绝**时产生，成对记在 decision 前面 */
const requests = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.request' ? [e.payload] : []));

beforeEach(async () => {
  const realNative = promisify(realpathCb.native);
  dir = await realNative(await mkdtemp(join(tmpdir(), 'xm-shell-claims-')));
  home = await realNative(await mkdtemp(join(tmpdir(), 'xm-shell-home-')));
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_rsa'), 'PRIVATE\n');
  await writeFile(join(dir, 'ok.txt'), 'fine\n');
  ENV = {
    home,
    appRoot: join(dir, 'repo'),
    dataDir: join(home, '.xiaoming'),
    configDir: join(home, '.config', 'xiaoming'),
  };
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
    const { exec } = await harness();
    const all = await exec(argv);

    expect(ended(all)[0]?.ok).toBe(false);
    const denied = decisions(all).filter((d) => d.effect === 'deny');
    expect(denied[0]?.ruleId).toBe('red.fs-delete-home-root');
    // 拒绝一次就结束这次调用：恰好一对审计记录，且是判定自己做的决定
    expect(requests(all)).toHaveLength(1);
    expect(denied[0]?.by).toBe('policy');
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
  it.each([
    ['runtime data', (root: string) => ['cat', join(root, '.xiaoming', 'events.db')]],
    ['user config and secrets', (root: string) => ['cat', join(root, '.config', 'xiaoming', 'secrets.json')]],
    ['security source', () => ['rm', join(ENV.appRoot, 'packages', 'runtime', 'src', 'turn.ts')]],
  ])('analyzable commands cannot touch protected %s', async (_label, argvFor) => {
    const { exec } = await harness();
    const all = await exec(argvFor(home));
    expect(ended(all)[0]?.ok).toBe(false);
    expect(decisions(all)[0]?.ruleId).toMatch(/^red\.(private-|self-modify-)/);
    expect(started(all)).toHaveLength(0);
  });

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
        match: { target: 'localhost:1' },
        reason: '用例放行，只为看能力有没有被记下来',
        immutable: false,
      },
    ]);
    /*
     * `tool.start` 只在 `executeCall` 里发（`turn.ts`），而那只在全部主张判完
     * 都是 allow 之后才会走到——被拒的调用只会有 `tool.end{ok:false}`，压根
     * 不会有 `tool.start`。所以这条用例**必须真的走到执行**，也就必须真的
     * spawn 一次 curl，没有绕开的办法（本文件其它用例断言 `deny` 是因为它们
     * 测的正是"别执行"，这条用例的性质完全相反）。
     *
     * 之前打真实外网地址（`https://example.com/a`）在 Windows CI runner 上
     * 量出了两个连带问题：一是真的 curl 出网偶发挂起/变慢，超过 vitest 5s 的
     * testTimeout；二是超时后子进程没被杀干净，拿会话 cwd 当自己的工作目录
     * 一直占着，afterEach 的 rm(dir) 就撞上 `EBUSY: resource busy or locked`
     * ——Windows 上运行中进程会锁住自己的 cwd，POSIX 上不会，这个坑只在
     * Windows 上现形。
     *
     * 换成 `localhost:1`（一个几乎必然没人监听的端口）之后：
     *   · `localhost` 是主机名，不是字面量 IP —— `matches()` 只在 IP 字面量上
     *     跑 `isPrivateOrReservedIp`（`engine.ts`），域名本身判不了也不需要判，
     *     所以不会撞上 SSRF 那条 deny，请求照常走到 allow → executeCall。
     *   · `localhost` 到回环地址的解析是操作系统本地完成的，不查真实网络，
     *     任何平台上都是毫秒级；连到一个没人监听的端口会立刻收到 RST/拒绝，
     *     不会像打真实外网那样可能悬着等。curl 因此总是快速地"连接失败"
     *     退出——退出码非零完全不影响断言（只看 `tool.start` 记的能力集合，
     *     不看 `ended`/退出码），却换来了不依赖任何真实网络访问的确定性。
     */
    const all = await exec(['curl', 'http://localhost:1/a']);
    expect(started(all)[0]?.capabilities).toContain('net.fetch');
  });
});

describe('放行的路径也要真的通', () => {
  it('shell.exec 声明的删除目标在执行前形成一个 v2 checkpoint', async () => {
    const target = join(dir, 'checkpoint-me.txt');
    await writeFile(target, 'before');
    const { exec } = await harness();
    const all = await exec(['rm', target]);
    const checkpoints = all.filter((event) => event.type === 'checkpoint.created');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.payload).toMatchObject({ kind: 'fs', manifestRef: { size: expect.any(Number) } });
  });

  it('普通命令零确认框跑起来', async () => {
    const { exec } = await harness();
    /*
     * 不能用 `echo`：它是 shell 内建，不是 PATH 上的可执行文件。
     * `shell.exec` 的契约是 `spawn(..., { shell: false })`（ADR-0026），
     * Windows 上 `spawn('echo')` 直接 ENOENT——这不是实现 bug，是测试选错了命令。
     * `process.execPath` 在任何跑 vitest 的环境里都在，三平台都能真的 spawn 起来。
     */
    const all = await exec([process.execPath, '-e', "process.stdout.write('hello-xm')"]);
    expect(ended(all)[0]?.ok).toBe(true);
    expect(JSON.stringify(ended(all)[0]?.forModel)).toContain('hello-xm');
    // 一条 permission 事件都没有 —— 放行不留痕，与 `fs.read` 这类一直如此的能力一致
    expect(requests(all)).toHaveLength(0);
    expect(decisions(all)).toHaveLength(0);
  });

  it('🔴 判不了的命令在网关就停了，不发权限事件 —— 判不了不是"先放行再说"', async () => {
    const { exec } = await harness();
    const all = await exec(['sh', '-c', 'rm -rf $(cat target)']);
    expect(ended(all)[0]?.ok).toBe(false);
    expect(decisions(all)).toHaveLength(0);
    expect(requests(all)).toHaveLength(0);
  });
});

async function sha256(data: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}

/**
 * ── 一次调用的多条主张：全过则零事件，任一被拒则恰好一对（ADR-0039）──
 *
 * 这组用例的前身考的是一个具体的 bug（ADR-0026 补记）：`mv a b` 拆出
 * `shell.exec` + `fs.read(a)` + `fs.delete(a)` + `fs.write(b)`，其中三条是 ask。
 * 两段式循环会把三条 `permission.request` 连着发完才轮到第一条的 decision，
 * 而 `pendingPermission` 是单槽位——UI 卡片和"谁在被等待"对不上，用户点了没反应。
 *
 * ADR-0039 之后没有 ask、没有单槽位、也没有卡片，那个 bug 的载体整个消失了。
 * 留下来的是同一个位置上现在**应该**成立的形状，也是"零确认框"这句话在
 * 多主张情况下的确切含义：**放行路径一条 permission 事件都不产生。**
 */
describe('多主张调用的事件形状', () => {
  it('mv 的四条主张全部放行 —— 事件流里没有任何 permission 事件', async () => {
    const { exec } = await harness();
    await writeFile(join(dir, 'src.txt'), 'hi');
    const all = await exec(['mv', join(dir, 'src.txt'), join(dir, 'dst.txt')]);

    expect(ended(all)[0]?.ok).toBe(true);
    expect(requests(all)).toHaveLength(0);
    expect(decisions(all)).toHaveLength(0);
  });

  it('🔴 其中一条主张撞上 deny：恰好一对 request/decision，然后这次调用结束', async () => {
    const { exec } = await harness([
      {
        id: 'u.no-delete-here',
        effect: 'deny',
        capability: 'fs.delete',
        match: { target: `${dir}/**` },
        reason: '用户自己写的：这个目录里的东西不许删',
        immutable: false,
      },
    ]);
    await writeFile(join(dir, 'src.txt'), 'hi');
    const all = await exec(['mv', join(dir, 'src.txt'), join(dir, 'dst.txt')]);

    expect(ended(all)[0]?.ok).toBe(false);
    const sequence = all
      .map((e) => e.type)
      .filter((t) => t === 'permission.request' || t === 'permission.decision');
    expect(sequence).toEqual(['permission.request', 'permission.decision']);
    expect(decisions(all)[0]).toMatchObject({ effect: 'deny', ruleId: 'u.no-delete-here' });
  });
});
