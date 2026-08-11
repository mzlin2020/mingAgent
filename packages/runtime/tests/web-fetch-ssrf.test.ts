import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedEvent, PolicyRuleSet } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import type { PolicyEnv } from '@xm/kernel';
import { MemoryEventStore, ToolRegistry, composeRules } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';
import { coreTools, nodeToolGateway } from '@xm/tools-core';

/**
 * ── M1-d DoD：`web.fetch http://169.254.169.254/` 被拦 ──
 *
 * `shell-claims.test.ts` 证明的是"真实的 shell.exec 工具、真实的网关、真实的规则，
 * `rm -rf ~` 到不了 spawn"。这个文件证明的是网络那一半的同一句话："真实的 web.fetch
 * 工具、真实的网关、真实的 IP 段规则，`169.254.169.254` 到不了 TCP 连接"——
 * 内核测试（`ip-range.test.ts`/`policy-ssrf-deny.test.ts`）只证明了判定逻辑本身对，
 * 这里证明的是它真的接在了调用链上。
 */

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
  readonly userRules?: PolicyRuleSet;
  readonly dnsLookup?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: 4 | 6 }[]>;
}

async function harness({ userRules = [], dnsLookup }: HarnessOptions = {}) {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/', modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  for (const t of coreTools({ os: 'linux' })) tools.register(t);

  const exec = async (url: string): Promise<PersistedEvent[]> => {
    await runTurn(
      {
        runtime,
        tools,
        layers: composeRules({ env: ENV, user: userRules }),
        model: 'scripted-1',
        gateway: nodeToolGateway({ ...(dnsLookup === undefined ? {} : { dnsLookup }) }),
        provider: new ScriptedProvider({ turns: [call('web.fetch', { url }), END] as never }),
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
/**
 * ADR-0039 之后 `permission.request` 只在**拒绝**时产生（成对记在 decision 前面）。
 * 于是"这次调用有没有撞上拒绝清单"就等于"事件流里有没有 request"——
 * 以前这个信息靠注入一个记账用的 `decide()` 拿，那条注入点已经不存在了。
 */
const requests = (all: PersistedEvent[]) =>
  all.flatMap((e) => (e.type === 'permission.request' ? [e.payload] : []));

beforeEach(() => {
  ENV = { home: '/home/ming', appRoot: '/repo', dataDir: '/home/ming/.xiaoming' };
});

describe('🔴 M1-d DoD：web.fetch 解析到保留网段一律被拦', () => {
  it.each([
    ['云元数据端点', 'http://169.254.169.254/'],
    ['回环', 'http://127.0.0.1:9/'],
    ['RFC 1918 私网', 'http://10.1.2.3/'],
  ])('%s → deny，一个确认框都不弹', async (_label, url) => {
    const { exec } = await harness();
    const all = await exec(url);

    expect(ended(all)[0]?.ok).toBe(false);
    const denied = decisions(all).filter((d) => d.effect === 'deny');
    expect(denied[0]?.ruleId).toBe('def.no-fetch-private-network');
    // 拒绝是判定当场做出的，不经过任何人 —— 所有 decision 都是 policy 判的
    expect(decisions(all).every((d) => d.by === 'policy')).toBe(true);
    expect(JSON.stringify(ended(all)[0]?.forModel)).toMatch(/保留|内网/);
  });

  /*
   * 这里刻意**不**用一个"看起来公网"的假地址，因为测试服务器只能架在回环上——
   * 用回环地址去证明"公网不受影响"是在骗自己。真正有价值的断言是分层覆盖
   * （ADR-0023）打通到了这条新规则：用户在自己的配置里对解析出的具体地址写一条
   * allow，默认 deny 被压过去，且请求真的能连通、拿到响应——不是"判定上说允许了"
   * 就算数，是"最终真的建立了连接"。
   */
  it('用户显式对解析出的地址写一条 allow，覆盖默认 deny，且请求真的能连通', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('来自测试服务器');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('监听失败');
    const port = address.port;

    try {
      const { exec } = await harness({
        dnsLookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        userRules: [
          {
            id: 'user.allow-test-server',
            effect: 'allow',
            capability: 'net.fetch',
            match: { target: '127.0.0.1*' },
            reason: '测试用例本机服务器',
            immutable: false,
          },
        ],
      });
      const all = await exec(`http://web-fetch-e2e-test.invalid:${String(port)}/`);

      /*
       * 两条 claim 各自的命运不同：域名那条（claim A）没有任何规则匹配它，走兜底放行；
       * 解析出的 IP 那条（claim B）命中用户新写的 allow，覆盖了内置的
       * `def.no-fetch-private-network`。两条只要有一条被拒，整次调用就会被拒——
       * 这次都没被拒，请求才真的连通。
       */
      // 放行的路径不产生任何 permission.request —— 只有拒绝才记
      expect(requests(all)).toHaveLength(0);
      expect(ended(all)[0]?.ok).toBe(true);
      expect(JSON.stringify(ended(all)[0]?.forModel)).toContain('来自测试服务器');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
        resolve();
      });
      });
    }
  });
});

describe('🔴 解析出的 IP 主张仍然只用来查 deny（ADR-0028 / 曾经的 ADR-0036）', () => {
  /*
   * `resolveHost` 每个 URL 产出两条主张：可读域名（claim A）和解析出的 IP（claim B）。
   * claim B 存在只是为了让 SSRF 的 IP 段规则有东西可匹配——判定与建连必须看同一个
   * 地址，否则就是 DNS 重绑定的窗口（ADR-0028）。
   *
   * 它曾经要额外标一个 `checkOnly`（ADR-0036），因为它也命中 `def.net-fetch` 的 ask，
   * 于是每次联网弹两个框：一个域名、一个用户根本无从判断的裸 IP。ADR-0039 删掉 ask
   * 之后所有主张的待遇都一样了（只查 deny），标记随之删除——
   * **但 deny 的那一半必须一个字没动**，这就是这条用例钉的东西。
   */
  it('🔴 解析到保留网段仍然拦得住', async () => {
    const { exec } = await harness({
      dnsLookup: () => Promise.resolve([{ address: '10.1.2.3', family: 4 as const }]),
    });
    const all = await exec('https://looks-public.example/page');

    expect(ended(all)[0]?.ok).toBe(false);
    expect(decisions(all).find((d) => d.effect === 'deny')?.ruleId).toBe(
      'def.no-fetch-private-network',
    );
    /*
     * 恰好一条审计记录，且记的是**解析出的 IP**那条主张——不是域名。
     * 这一条同时证明了两件事：claim B 确实参与了 deny 判定（否则 SSRF 拦不住），
     * 以及它不再产生第二次"问用户"（因为已经没有问这个动作了）。
     */
    expect(requests(all)).toHaveLength(1);
    expect(requests(all)[0]?.target).toContain('10.1.2.3');
  });
});

describe('🔴 DNS 只解析一次：判定用的地址就是唯一被建连过的地址', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end('hit');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('监听失败');
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
        server.close(() => {
        resolve();
      });
      });
  });

  afterEach(() => {
    hits = 0;
  });

  it('注入的 dnsLookup 只被调用一次，且工具连的正是它给出的那个地址', async () => {
    const calls: string[] = [];
    const { exec } = await harness({
      dnsLookup: (hostname) => {
        calls.push(hostname);
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      },
      // 解析出的是回环地址，默认会被 def.no-fetch-private-network 拦下——
      // 这条用例要看的是"解析次数"和"连接地址"，不是 SSRF 判定本身，
      // 所以显式放开，让请求走到真正建连那一步
      userRules: [
        {
          id: 'user.allow-test-server',
          effect: 'allow',
          capability: 'net.fetch',
          match: { target: '127.0.0.1*' },
          reason: '测试用例本机服务器',
          immutable: false,
        },
      ],
    });

    const all = await exec(`http://web-fetch-e2e-rebinding.invalid:${String(port)}/`);

    expect(calls).toEqual(['web-fetch-e2e-rebinding.invalid']); // 恰好一次
    expect(hits).toBe(1); // 真的连到了那台服务器，也只连了一次
    expect(ended(all)[0]?.ok).toBe(true);
  });
});
