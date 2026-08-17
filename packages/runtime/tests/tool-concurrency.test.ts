import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent, ToolProgress } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, defineTool } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * 🔴 工具并发调度（ADR-0082，兑现 ADR-0005 一直没被写出来的那一半）。
 *
 * 在这个文件存在之前，驱动器是 `for (const call of calls) await dispatch(call)`——
 * 一次回复里的 5 个 `fs.read` 串成 5 段执行，而它们全都声明着 `path/read`。
 * `concurrency` 与 `resources()` 两个字段一路做到了每个工具定义里，**没有任何代码读过它们**。
 *
 * 这里同时钉住两侧：并行真的发生了，以及**写与独占绝不并行**。
 */

const ENV = {
  home: '/home/ming',
  sourceRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

/** 同时在跑的工具数：`peak` 是这一轮的最大同时在跑数 */
class Tracker {
  live = 0;
  peak = 0;
  readonly finished: string[] = [];

  enter(): void {
    this.live += 1;
    this.peak = Math.max(this.peak, this.live);
  }

  leave(name: string): void {
    this.live -= 1;
    this.finished.push(name);
  }
}

const Input = z.strictObject({ path: z.string() });

/** 慢工具：执行期间挂 40ms，好让"有没有重叠"看得出来 */
const slowTool = (
  name: string,
  tracker: Tracker,
  options: {
    readonly mode?: 'read' | 'write';
    readonly concurrency?: 'parallel' | 'exclusive';
  },
) =>
  defineTool({
    name,
    group: 'demo',
    description: '一个慢工具。仅用于验证调度。',
    inputSchema: Input,
    risk: 'safe',
    // opaque 能力：这条用例验的是调度，不是判权（路径能力会要求网关产出主张）
    capabilities: ['env.read'],
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.mode === undefined
      ? {}
      : {
          resources: (input: z.infer<typeof Input>) => [
            { kind: 'path' as const, mode: options.mode ?? 'read', glob: input.path },
          ],
        }),
    outputSchema: z.strictObject({ path: z.string() }),
    async *execute(input): AsyncIterable<ToolProgress> {
      tracker.enter();
      try {
        await new Promise((resolve) => setTimeout(resolve, 40));
      } finally {
        tracker.leave(`${name}:${input.path}`);
      }
      yield { kind: 'result', forModel: [{ type: 'text', text: input.path }], output: { path: input.path } };
    },
  });

const END = { chunks: [{ kind: 'stop', reason: 'end_turn' }] as never };

/** 一次回复里发若干个工具调用 */
const manyCalls = (calls: readonly (readonly [string, string])[]) => ({
  chunks: [
    ...calls.flatMap(([name, path]) => {
      const id = newCallId();
      return [
        { kind: 'tool_call_start' as const, id, name },
        { kind: 'tool_call_delta' as const, id, argsJson: JSON.stringify({ path }) },
        { kind: 'tool_call_end' as const, id },
      ];
    }),
    { kind: 'stop' as const, reason: 'tool_use' as const },
  ],
});

async function run(
  calls: readonly (readonly [string, string])[],
): Promise<{ tracker: Tracker; events: PersistedEvent[]; elapsed: number }> {
  const tracker = new Tracker();
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });

  const tools = new ToolRegistry();
  tools.register(slowTool('demo.read', tracker, { mode: 'read' }));
  tools.register(slowTool('demo.write', tracker, { mode: 'write' }));
  tools.register(slowTool('demo.plain', tracker, { concurrency: 'parallel' }));
  tools.register(slowTool('demo.exclusive', tracker, { concurrency: 'exclusive' }));

  const startedAt = Date.now();
  await runTurn(
    {
      runtime,
      executor: localExecutionWorld,
      tools,
      layers: builtinLayers(ENV),
      model: 'scripted-1',
      provider: new ScriptedProvider({ turns: [manyCalls(calls), END] as never }),
    },
    textInput('干活'),
  );
  const elapsed = Date.now() - startedAt;

  const events: PersistedEvent[] = [];
  for await (const e of store.read(sessionId)) events.push(e);
  return { tracker, events, elapsed };
}

const read = (path: string) => ['demo.read', path] as const;

describe('🔴 只读调用并行', () => {
  it('三个只读调用同时在跑，总耗时接近一次而不是三次', async () => {
    const { tracker, events, elapsed } = await run([read('a'), read('b'), read('c')]);

    expect(tracker.peak).toBe(3);
    // 串行是 3×40ms；并行是 1×40ms。留足余量，只要不是"三段依次"就行
    expect(elapsed).toBeLessThan(100);
    const ends = events.flatMap((e) => (e.type === 'tool.end' ? [e.payload] : []));
    expect(ends).toHaveLength(3);
    expect(ends.every((end) => end.ok)).toBe(true);
  });

  it('没有资源声明但自称 parallel 的工具也并行（web.fetch 这一类）', async () => {
    const { tracker } = await run([
      ['demo.plain', 'x'],
      ['demo.plain', 'y'],
    ]);
    expect(tracker.peak).toBe(2);
  });

  it('一批最多 8 个：10 个只读调用切成两批', async () => {
    const calls = Array.from({ length: 10 }, (_, i) => read(`f${String(i)}`));
    const { tracker } = await run(calls);
    expect(tracker.peak).toBe(8);
  });
});

describe('🔴 写与独占绝不并行', () => {
  it('声明了 write 的工具独占一批，前后的只读调用不与它重叠', async () => {
    const { tracker } = await run([read('a'), ['demo.write', 'b'], read('c')]);
    expect(tracker.peak).toBe(1);
  });

  it('concurrency: exclusive 独占一批', async () => {
    const { tracker } = await run([read('a'), ['demo.exclusive', 'b'], read('c')]);
    expect(tracker.peak).toBe(1);
  });

  /*
   * 模型给出的先后关系只在"并行安全"的连续段内被打散。
   * 一次写把序列切成三段，段与段之间的顺序必须一字不动——
   * 否则"先读旧内容、再写、再读新内容"这种最常见的序列会读到错的那一份。
   */
  it('批次之间保序：写之前的读一定先完成，写之后的读一定后开始', async () => {
    const { tracker } = await run([read('a'), read('b'), ['demo.write', 'w'], read('c')]);
    expect(tracker.peak).toBe(2); // a、b 同批；w 独占；c 独占（它前面是 w）
    expect(tracker.finished.slice(0, 2).sort()).toEqual(['demo.read:a', 'demo.read:b']);
    expect(tracker.finished[2]).toBe('demo.write:w');
    expect(tracker.finished[3]).toBe('demo.read:c');
  });
});
