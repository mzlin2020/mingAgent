import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, defineTool, pureGateway } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * ── 联网搜索的审批噪音，走完整条真实路径（ADR-0034）──
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

const callChunks = (url: string) => {
  const id = newCallId();
  return [
    { kind: 'tool_call_start' as const, id, name: 'web.fetch' },
    { kind: 'tool_call_delta' as const, id, argsJson: JSON.stringify({ url }) },
    { kind: 'tool_call_end' as const, id },
    { kind: 'stop' as const, reason: 'tool_use' as const },
  ];
};

const targetOf = (_name: string, input: unknown): string => (input as { url?: string }).url ?? '';

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

async function harness() {
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

  const deps = {
    runtime,
    tools,
    layers: builtinLayers(ENV),
    // 用户开的是「帮我批准」/「完全访问权限」，两者都映射到 yolo（ADR-0030）
    tier: 'yolo' as const,
    model: 'scripted-1',
    gateway: pureGateway(targetOf),
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
          provider: new ScriptedProvider({ turns: [{ chunks: callChunks(url) }, END] as never }),
        },
        textInput(`看看 ${url}`),
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

describe('联网搜索：同一个域名不该被反复询问', () => {
  it('🔴 同一个域名只问一次，之后不再出现确认框', async () => {
    const h = await harness();

    await h.fetch('https://search.example/q=x'); // ① 干净上下文，yolo 直接放行
    expect(h.runtime.state.untrustedContext).toBeDefined(); // 第一次 fetch 就把自己污染了

    await h.fetch('https://a.example/1'); // ② 已污染 → 降级成 ask，用户点"本会话都允许"
    await h.fetch('https://a.example/2'); // ③ 同一个域名 → 不该再问
    await h.fetch('https://a.example/3'); // ④ 还是不该再问

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual(['https://a.example/1']);
    expect(ranTools(events)).toBe(4);
  });

  it('每个**新**域名各问一次 —— 这是有意义的提问，不该被一并消掉', async () => {
    const h = await harness();

    await h.fetch('https://search.example/q=x');
    await h.fetch('https://a.example/1');
    await h.fetch('https://b.example/1');
    await h.fetch('https://a.example/2'); // 回到已授权的域名，不再问

    const events = await collect(h.store, h.sessionId);
    expect(askedTargets(events)).toEqual(['https://a.example/1', 'https://b.example/1']);
  });

  it('🔴 授权只对被授权的那个域名生效，不是"从此联网自由"', async () => {
    const h = await harness();

    await h.fetch('https://search.example/q=x');
    await h.fetch('https://a.example/1');

    const before = askedTargets(await collect(h.store, h.sessionId)).length;
    await h.fetch('https://evil.example/exfil'); // 注入让它往新域名发东西 → 必须再问
    const after = askedTargets(await collect(h.store, h.sessionId));

    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toBe('https://evil.example/exfil');
  });
});
