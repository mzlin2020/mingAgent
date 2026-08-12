import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BlobRef, ModelChunk } from '@xm/contracts';
import { newCallId, newSessionId } from '@xm/contracts';
import { MemoryBlobStore, MemoryEventStore, ToolRegistry, defineTool } from '@xm/kernel';
import {
  EventBus,
  RESULT_EXPAND,
  ScriptedProvider,
  SessionRuntime,
  resultExpandTool,
  runTurn,
  textInput,
} from '@xm/runtime';
import { z } from 'zod';

const sha256 = (data: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(data).digest('hex'));

describe('result.expand', () => {
  it('从截断标记取得引用后，只展开当前会话所需的行范围', async () => {
    const full = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1).padStart(3, '0')}`).join(
      '\n',
    );
    const hash = await sha256(new TextEncoder().encode(full));
    const locator = `blob:sha256:${hash}`;
    const blobs = new MemoryBlobStore(sha256);
    const runtime = await SessionRuntime.open({
      sessionId: newSessionId(),
      store: new MemoryEventStore(),
      bus: new EventBus(),
    });
    await runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'scripted/scripted-1' },
    });

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'demo.echo',
        group: 'demo',
        description: '返回长结果的测试工具',
        inputSchema: z.strictObject({}),
        risk: 'safe',
        capabilities: [],
        concurrency: 'parallel',
        resultLimits: { maxBytes: 120, strategy: 'head' },
        async *execute() {
          const text = await Promise.resolve(full);
          yield { kind: 'result' as const, forModel: [{ type: 'text' as const, text }] };
        },
      }),
    );
    tools.register(
      resultExpandTool({
        blobs,
        resolveRef: async ({ hash: wanted }) => findRef(runtime, wanted),
      }),
    );

    const longCall = newCallId();
    const expandCall = newCallId();
    const provider = new ScriptedProvider({
      turns: [
        {
          chunks: [
            { kind: 'tool_call_start', id: longCall, name: 'demo.echo' },
            { kind: 'tool_call_delta', id: longCall, argsJson: '{}' },
            { kind: 'tool_call_end', id: longCall },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        {
          chunks: [
            { kind: 'tool_call_start', id: expandCall, name: RESULT_EXPAND },
            {
              kind: 'tool_call_delta',
              id: expandCall,
              argsJson: JSON.stringify({ ref: locator, offset: 95, limit: 3 }),
            },
            { kind: 'tool_call_end', id: expandCall },
            { kind: 'stop', reason: 'tool_use' },
          ] satisfies ModelChunk[],
        },
        { chunks: [{ kind: 'stop', reason: 'end_turn' }] satisfies ModelChunk[] },
      ],
    });

    await runTurn(
      { runtime, provider, tools, layers: [], model: 'scripted-1', blobs },
      textInput('读取长结果的一小段'),
    );

    const events = [];
    for await (const event of runtime.read()) events.push(event);
    const longEnd = events.find(
      (event) => event.type === 'tool.end' && event.payload.callId === longCall,
    );
    const expandEnd = events.find(
      (event) => event.type === 'tool.end' && event.payload.callId === expandCall,
    );
    expect(JSON.stringify(longEnd?.payload.forModel)).toContain(locator);
    expect(JSON.stringify(longEnd?.payload.fullRef)).toContain(hash);
    expect(JSON.stringify(expandEnd?.payload.forModel)).toContain('95\\tline-095');
    expect(JSON.stringify(expandEnd?.payload.forModel)).toContain('97\\tline-097');
    expect(JSON.stringify(expandEnd?.payload.forModel)).not.toContain('94\\tline-094');

    await runtime.close();
    await blobs.close();
  });

  it('拒绝当前会话不可达的 hash', async () => {
    const blobs = new MemoryBlobStore(sha256);
    const foreign = await blobs.put(new TextEncoder().encode('secret'), 'text/plain');
    const tool = resultExpandTool({ blobs, resolveRef: () => Promise.resolve(undefined) });
    const progress = [];
    for await (const item of tool.execute(
      { ref: `blob:sha256:${foreign.hash}`, offset: 1, limit: 10 },
      {
        sessionId: newSessionId(),
        signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
        cwd: '/w',
        executor: 'local',
      },
    )) {
      progress.push(item);
    }
    expect(JSON.stringify(progress)).toMatch(/不属于当前会话/);
    await blobs.close();
  });
});

async function findRef(runtime: SessionRuntime, hash: string): Promise<BlobRef | undefined> {
  for await (const event of runtime.read()) {
    if (event.type === 'tool.end' && event.payload.fullRef?.hash === hash) {
      return event.payload.fullRef;
    }
  }
  return undefined;
}
