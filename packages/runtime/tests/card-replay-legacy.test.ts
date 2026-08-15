import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newCallId, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import type { CallId, PersistedEvent } from '@xm/contracts';
import type { SealedEvent } from '@xm/kernel';
import {
  ToolRegistry,
  defineTool,
  emptySessionState,
  projectSessionCards,
  reduce,
  sealEvent,
} from '@xm/kernel';
import { openStores } from '@xm/storage';

/**
 * 真实尺寸的旧库回放（ADR-0058 反向演练 2）。
 *
 * ── 为什么不用小夹具 ──
 *
 * `docs/experience` 里记着一条教训：M2 复审时两条能力级失效整片绕开了测试，
 * 原因就是夹具太小。展示路径尤其吃这个亏——一条畸形事件在 20 条的夹具里
 * 一眼看得出，在一个用了几个月、几万条事件的库里只表现为"这个会话打不开"。
 *
 * 所以这里落一个**真的 SQLite 库**、写进**真实条数**的事件，其中掺着：
 *  · 字段名换过的旧版本入参（`file` 而不是 `path`）
 *  · 被截断成碎片的入参
 *  · 工具已经不在注册表里的历史调用（插件卸载 / 工具改名）
 *  · 落库的展示事实形状对不上当前 schema 的
 * 然后原样回放、原样投影，要求**一张卡片都不许把回放掀翻**。
 */

const ROOT = mkdtempSync(join(tmpdir(), 'xm-card-replay-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 真实尺寸：2000 次工具调用 ≈ 6000 条事件，对应用几个月的会话 */
const CALLS = 2000;

const tools = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'fs.read',
      group: 'fs',
      description: '读文件',
      inputSchema: z.strictObject({ path: z.string() }),
      risk: 'safe',
      capabilities: ['fs.read'],
      pathInputs: ['path'],
      presentationSchema: z.strictObject({ lines: z.number() }),
      /*
       * 故意写成"照着当前入参形状直接用"的自然写法——`.split()` 在旧版本入参上会当场抛。
       * 投影函数就该这么写：它不是防御性代码的地方，扛住畸形是**软校验层**的职责。
       */
      presentCall: (input) => ({
        kind: 'generic',
        title: '读取',
        summary: input.path.split('/').at(-1) ?? input.path,
        locations: [{ path: input.path }],
      }),
      presentResult: (input, outcome) => ({
        kind: 'generic',
        title: '读取',
        // 故意用一下落库事实：形状不对时它是 undefined，投影必须自己扛住
        summary: `${input.path}（${String(outcome.presentation?.lines ?? 0)} 行）`,
        body: outcome.text,
      }),
      // eslint-disable-next-line require-yield
      async *execute() {
        await Promise.resolve();
        throw new Error('本用例不执行工具');
      },
    }),
  );
  return registry;
};

describe('M3-f 卡片投影：真实尺寸旧库回放', () => {
  it('🔴 几千条含畸形/旧版/已卸载工具的历史，全量投影一张都不崩', async () => {
    const stores = await openStores({
      home: ROOT,
      appRoot: join(ROOT, 'app'),
      data: join(ROOT, 'data'),
      config: join(ROOT, 'config'),
      cache: join(ROOT, 'cache'),
      logs: join(ROOT, 'logs'),
    });
    const sessionId = newSessionId();
    const turnId = newTurnId();
    let seq = 0;
    const stamp = (event: Omit<PersistedEvent, 'id' | 'seq' | 'ts' | 'v' | 'sessionId'>) =>
      ({
        ...event,
        id: newMessageId() as unknown as string,
        seq: ++seq,
        ts: 1_700_000_000_000 + seq,
        v: 1,
        sessionId,
      }) as unknown as PersistedEvent;
    const sealed = (event: Omit<PersistedEvent, 'id' | 'seq' | 'ts' | 'v' | 'sessionId'>) =>
      sealEvent(stamp(event));

    const batch: SealedEvent[] = [
      sealed({
        type: 'session.created',
        payload: { cwd: '/w', modelRef: 'anthropic/x' },
      }),
      sealed({ type: 'turn.start', turnId, payload: { turnId, input: [] } }),
    ];
    const calls: CallId[] = [];
    for (let index = 0; index < CALLS; index += 1) {
      const callId = newCallId();
      calls.push(callId);
      const shape = index % 6;
      const input =
        shape === 0
          ? { path: `/w/src/file-${String(index)}.ts` }
          : shape === 1
            ? { file: `/w/src/legacy-${String(index)}.ts` } // 旧版本字段名
            : shape === 2
              ? `{"path":"/w/src/truncat` // 被截断的碎片
              : shape === 3
                ? { path: index } // 类型对不上
                : shape === 4
                  ? null // 早期版本压根没记入参
                  : { path: `/w/src/ok-${String(index)}.ts` };
      // 每七次里有一次指向一个当前注册表里不存在的工具（插件卸载 / 工具改名）
      const name = index % 7 === 0 ? '已卸载.工具' : 'fs.read';
      batch.push(
        sealed({
          type: 'message.end',
          turnId,
          payload: {
            message: {
              id: newMessageId(),
              role: 'assistant',
              blocks: [{ type: 'tool_use', id: callId, name, input }],
              ts: 1,
            },
          },
        }),
        sealed({
          type: 'tool.start',
          turnId,
          payload: {
            callId,
            messageId: newMessageId(),
            name,
            input,
            risk: 'safe',
            capabilities: ['fs.read'],
          },
        }),
        sealed({
          type: 'tool.end',
          turnId,
          payload: {
            callId,
            ok: shape !== 3,
            durationMs: 1,
            forModel: [{ type: 'text', text: `第 ${String(index)} 次调用的结果` }],
            // 每三次里有一次落库事实形状对不上当前 schema
            presentation: index % 3 === 0 ? { lines: index } : { rows: index },
          },
        }),
      );
    }
    const writer = await stores.events.openForWrite(sessionId);
    // 分批写：一次几千条的事务在真实使用里也不存在，逐段追加更接近生产
    for (let offset = 0; offset < batch.length; offset += 500) {
      await writer.append(batch.slice(offset, offset + 500));
    }
    await writer.close();

    // 原样从盘上读回来，走与生产一致的解析 + reduce 路径
    const replayed: PersistedEvent[] = [];
    for await (const event of stores.events.read(sessionId)) replayed.push(event);
    expect(replayed.length).toBe(batch.length);
    const state = replayed.reduce(reduce, emptySessionState(sessionId));

    const cards = projectSessionCards(state, tools());
    expect(cards.size).toBe(CALLS);
    for (const callId of calls) {
      const pair = cards.get(callId);
      expect(pair?.call).toBeDefined();
      expect(pair?.result).toBeDefined();
      // 降级也必须是一张**合法**卡片：有摘要、有种类，渲染层拿到它不会白屏
      expect(pair?.result?.summary.length).toBeGreaterThan(0);
    }
    // 形状对不上的落库事实没有被喂进投影：那些卡片显示 0 行，而不是显示一个 undefined
    const legacyMeta = cards.get(calls[1]!)?.result;
    expect(legacyMeta?.kind).toBe('generic');
    await stores.close();
  }, 60_000);
});
