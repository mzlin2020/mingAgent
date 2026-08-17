import { localExecutionWorld } from '@xm/tool-runtime';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnyEvent, ContentBlock, XmEventType } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import { MemoryBlobStore, MemoryEventStore, ToolRegistry, builtinLayers } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

/**
 * `runTurn` 的多模态入口：`ContentBlock[]` 输入 + vision 能力闸门（ADR-0029）。
 *
 * 闸门必须**在记任何事件之前**判——反例那条测试断言的正是"事件流里干干净净，
 * 不是记了 turn.start 却没有配对的 turn.end"，这才是 ADR-0008 包含性不变量
 * 真正在乎的事。
 */

const ENV = { home: '/home/ming', sourceRoot: '/repo', dataDir: '/home/ming/.local/share/xiaoming', configDir: '/home/ming/.config/xiaoming' };

const sha256Hex = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

async function harness() {
  const store = new MemoryEventStore();
  const bus = new EventBus();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus });
  await runtime.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });

  const types: XmEventType[] = [];
  bus.subscribe((e: AnyEvent) => {
    types.push(e.type);
  }, sessionId);

  return { store, sessionId, runtime, tools: new ToolRegistry(), layers: builtinLayers(ENV), types };
}

describe('textInput()', () => {
  it('把纯文字包成单个 text 块', () => {
    expect(textInput('你好')).toEqual([{ type: 'text', text: '你好' }]);
  });
});

describe('runTurn 的能力闸门：图片', () => {
  it('🔴 模型不支持 vision + 带图片输入 → 记任何事件之前就 throw', async () => {
    const h = await harness();
    const blobs = new MemoryBlobStore(sha256Hex);
    const ref = await blobs.put(new TextEncoder().encode('假图片'), 'image/png');

    const input: ContentBlock[] = [{ type: 'image', source: ref }, ...textInput('这是什么')];

    await expect(
      runTurn(
        {
          runtime: h.runtime,
          executor: localExecutionWorld,
          // 默认 ScriptedProvider 的 capabilities.vision === false
          provider: new ScriptedProvider({ turns: [] }),
          tools: h.tools,
          layers: h.layers,
          model: 'scripted-1',
        },
        input,
      ),
    ).rejects.toThrow(/vision|图片/);

    // 决定性断言：不是"报了错但顺手记了一条孤立的 turn.start"
    expect(h.types).toEqual([]);
    expect(h.runtime.state.messages).toHaveLength(0);
  });

  it('模型支持 vision → 正常跑完，事件与最终状态里都能看到图片块', async () => {
    const h = await harness();
    const blobs = new MemoryBlobStore(sha256Hex);
    const ref = await blobs.put(new TextEncoder().encode('假图片'), 'image/png');

    const input: ContentBlock[] = [{ type: 'image', source: ref }, ...textInput('这是什么')];

    const reason = await runTurn(
      {
        runtime: h.runtime,
        executor: localExecutionWorld,
        provider: new ScriptedProvider({
          capabilities: { vision: true },
          turns: [
            { chunks: [{ kind: 'text_delta', text: '看到了。' }, { kind: 'stop', reason: 'end_turn' }] },
          ],
        }),
        tools: h.tools,
        layers: h.layers,
        model: 'scripted-1',
      },
      input,
    );

    expect(reason).toBe('end_turn');
    expect(h.types).toContain('turn.start');
    expect(h.types).toContain('turn.end');

    const firstMessage = h.runtime.state.messages[0];
    expect(firstMessage?.blocks.some((b) => b.type === 'image' && b.source.hash === ref.hash)).toBe(
      true,
    );
  });

  it('🔴 模型不支持 documents + 带文档输入 → 同样在记事件之前 throw', async () => {
    const h = await harness();
    const input: ContentBlock[] = [
      { type: 'document', source: { hash: 'a'.repeat(64), mime: 'application/pdf', size: 3 } },
      ...textInput('总结一下'),
    ];

    await expect(
      runTurn(
        {
          runtime: h.runtime,
          executor: localExecutionWorld,
          provider: new ScriptedProvider({ turns: [] }),
          tools: h.tools,
          layers: h.layers,
          model: 'scripted-1',
        },
        input,
      ),
    ).rejects.toThrow(/文档/);

    expect(h.types).toEqual([]);
  });
});
