import { localExecutionWorld } from '@xm/tool-runtime';
import { describe, expect, it } from 'vitest';
import type { ModelChunk } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers } from '@xm/kernel';
import { EventBus, ScriptedProvider, SessionRuntime, runTurn, textInput } from '@xm/runtime';

const ENV = {
  home: '/home/ming',
  sourceRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

const maxTokensTurn = (thinking: string): { chunks: ModelChunk[] } => ({
  chunks: [
    { kind: 'thinking_delta', text: thinking },
    {
      kind: 'usage',
      usage: { inputTokens: 100, outputTokens: 16_384, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    { kind: 'stop', reason: 'max_tokens' },
  ],
});

async function runtime(): Promise<SessionRuntime> {
  const sessionId = newSessionId();
  const opened = await SessionRuntime.open({
    sessionId,
    store: new MemoryEventStore(),
    bus: new EventBus(),
  });
  await opened.record({
    type: 'session.created',
    payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' },
  });
  return opened;
}

describe('单次模型输出达到上限', () => {
  it('没有形成工具调用时自动续写一次，而不是静默结束整个任务', async () => {
    const rt = await runtime();
    const provider = new ScriptedProvider({
      turns: [
        maxTokensTurn('方案还没落盘。'),
        {
          chunks: [
            { kind: 'text_delta', text: '已继续并完成。' },
            { kind: 'stop', reason: 'end_turn' },
          ],
        },
      ],
    });

    const reason = await runTurn(
      {
        runtime: rt,
        executor: localExecutionWorld,
        provider,
        tools: new ToolRegistry(),
        layers: builtinLayers(ENV),
        model: 'scripted-1',
      },
      textInput('完成任务'),
    );

    expect(reason).toBe('end_turn');
    expect(provider.consumedTurns).toBe(2);
    expect(rt.state.messages.some((message) => JSON.stringify(message).includes('已继续并完成'))).toBe(true);
  });

  it('连续第二次仍达到上限时明确告警并停止，避免无限续写', async () => {
    const rt = await runtime();
    const provider = new ScriptedProvider({
      turns: [maxTokensTurn('第一次过长。'), maxTokensTurn('第二次仍然过长。')],
    });

    const reason = await runTurn(
      {
        runtime: rt,
        executor: localExecutionWorld,
        provider,
        tools: new ToolRegistry(),
        layers: builtinLayers(ENV),
        model: 'scripted-1',
      },
      textInput('完成任务'),
    );

    expect(reason).toBe('max_tokens');
    expect(provider.consumedTurns).toBe(2);
    expect(rt.state.notices.at(-1)).toMatchObject({
      level: 'warn',
      code: 'turn.max_tokens',
    });
  });
});
