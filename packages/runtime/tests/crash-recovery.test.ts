import { describe, expect, it } from 'vitest';
import { newCallId, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import { MemoryEventStore, ToolRegistry, builtinLayers, emptySessionState, reduce } from '@xm/kernel';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  abandonOrphanedTurn,
  resumeTurn,
  scanForOrphanedSessions,
  synthesizeInterruption,
} from '@xm/runtime';

const ENV = { home: '/home/ming', appRoot: '/repo', dataDir: '/home/ming/.local/share/xiaoming', configDir: '/home/ming/.config/xiaoming' };

/**
 * `scanForOrphanedSessions`/`abandonOrphanedTurn`/`resumeTurn` 端到端验证。
 *
 * 每个用例都**手工构造**"写到一半"的事件流（直接调 `runtime.record()`，不经过
 * `runTurn()`），模拟"进程在这里被杀掉"。`scanForOrphanedSessions` 本身只读
 * （`store.read()`/`listSessions()`，不 `openForWrite()`），所以扫描这一步不需要
 * 模拟任何"重启"；`abandonOrphanedTurn`/`resumeTurn`/`synthesizeInterruption` 这几个
 * 写路径则继续用同一个 runtime 句柄验证逻辑本身是否正确。真正的"进程死后、
 * 新进程重新抢占陈旧写锁"（docs/04 §8 步骤 1 的另一半）留给 `crash-restart.test.ts`
 * 的真实 `SqliteEventStore` 场景——`MemoryEventStore` 没有 PID 概念，
 * 结构上就不支持模拟"同一个会话被两个不同进程先后打开"。
 */
describe('崩溃恢复：scanForOrphanedSessions / abandonOrphanedTurn / resumeTurn', () => {
  it('kind: tool —— 工具调用只有 tool.start，没有 tool.end', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: '列个目录' }] } });

    const callId = newCallId();
    const assistantMessageId = newMessageId();
    await dead.record({
      type: 'message.end',
      turnId,
      payload: {
        message: {
          id: assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } }],
          ts: Date.now(),
        },
      },
    });
    await dead.record({
      type: 'tool.start',
      turnId,
      payload: { callId, messageId: assistantMessageId, name: 'fs.list', input: { path: '/repo' }, risk: 'safe', capabilities: ['fs.read'] },
    });
    // 进程在这里死了——没有 tool.end，没有 turn.end

    const found = await scanForOrphanedSessions(store);
    expect(found).toHaveLength(1);
    expect(found[0]!.sessionId).toBe(sessionId);
    expect(found[0]!.orphan).toMatchObject({ turnId, kind: 'tool' });
    if (found[0]!.orphan.kind !== 'tool') throw new Error('expected tool-kind orphan');
    expect(found[0]!.orphan.calls).toHaveLength(1);
    expect(found[0]!.orphan.calls[0]!.callId).toBe(callId);
    expect(found[0]!.orphan.danglingToolUses).toEqual([]);

    // 补收尾 + turn.end(aborted)——scanForOrphanedSessions 已经证明了"只读扫描不用抢锁"，
    // 这里继续用同一个 runtime 句柄验证 synthesize/abandon 的逻辑本身；真实的"进程死后
    // 重新抢占陈旧写锁"由 crash-restart.test.ts 的真实 SqliteEventStore 场景覆盖
    // （MemoryEventStore 没有 PID 概念，结构上就不支持模拟这一步）
    const revived = dead;
    const reason = await abandonOrphanedTurn(revived, found[0]!.orphan);
    expect(reason).toBe('aborted');
    expect(revived.state.status).toBe('idle');
    expect(revived.state.activeTurn).toBeUndefined();
    expect(revived.state.runningCalls.size).toBe(0);
    const toolResult = revived.state.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({ toolUseId: callId, isError: true });

    // 回放整段落库的事件流，得出的状态必须与放弃之后的运行时状态一致——
    // 这是"重启不丢会话"这句 M1 DoD 落到测试里的最小形式
    let replayed = emptySessionState(sessionId);
    for await (const e of store.read(sessionId)) replayed = reduce(replayed, e);
    expect(replayed.status).toBe('idle');
    expect(replayed.runningCalls.size).toBe(0);
  });

  it('kind: tool —— 第 2 个调用执行中崩溃，第 3 个并行调用连 tool.start 都没有（danglingToolUses）', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: '改三个文件' }] } });

    const [first, second, third] = [newCallId(), newCallId(), newCallId()];
    const assistantMessageId = newMessageId();
    await dead.record({
      type: 'message.end',
      turnId,
      payload: {
        message: {
          id: assistantMessageId,
          role: 'assistant',
          blocks: [
            { type: 'tool_use', id: first, name: 'fs.write', input: { path: '/a' } },
            { type: 'tool_use', id: second, name: 'fs.write', input: { path: '/b' } },
            { type: 'tool_use', id: third, name: 'fs.write', input: { path: '/c' } },
          ],
          ts: Date.now(),
        },
      },
    });
    // 第 1 个调用已经跑完
    await dead.record({
      type: 'tool.start',
      turnId,
      payload: { callId: first, messageId: assistantMessageId, name: 'fs.write', input: { path: '/a' }, risk: 'medium', capabilities: ['fs.write'] },
    });
    await dead.record({
      type: 'tool.end',
      turnId,
      payload: { callId: first, ok: true, durationMs: 5, forModel: [{ type: 'text', text: 'ok' }] },
    });
    // 第 2 个调用正在执行——进程在这里死了，第 3 个调用连 tool.start 都没轮到
    await dead.record({
      type: 'tool.start',
      turnId,
      payload: { callId: second, messageId: assistantMessageId, name: 'fs.write', input: { path: '/b' }, risk: 'medium', capabilities: ['fs.write'] },
    });

    const found = await scanForOrphanedSessions(store);
    expect(found).toHaveLength(1);
    const orphan = found[0]!.orphan;
    expect(orphan).toMatchObject({ kind: 'tool' });
    if (orphan.kind !== 'tool') throw new Error('expected tool-kind orphan');
    expect(orphan.calls.map((c) => c.callId)).toEqual([second]);
    expect(orphan.danglingToolUses).toEqual([{ callId: third, name: 'fs.write', input: { path: '/c' } }]);

    const revived = dead;
    await abandonOrphanedTurn(revived, orphan);

    const toolResults = revived.state.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result');
    // 三个 tool_use 都要有对应的 tool_result：第 1 个正常完成，第 2/3 个被崩溃恢复补上
    expect(new Set(toolResults.map((b) => b.toolUseId))).toEqual(new Set([first, second, third]));
    expect(toolResults.find((b) => b.toolUseId === second)).toMatchObject({ isError: true });
    expect(toolResults.find((b) => b.toolUseId === third)).toMatchObject({ isError: true });
  });

  it('kind: message —— 模型正在流式输出时中断，message.interrupted(reason: crash) 第一次被真正 emit', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: '你好' }] } });
    const messageId = newMessageId();
    await dead.record({ type: 'message.start', turnId, payload: { messageId, role: 'assistant', model: 'x/y' } });

    const found = await scanForOrphanedSessions(store);
    expect(found[0]!.orphan).toMatchObject({ kind: 'message', messageId });

    const revived = dead;
    await abandonOrphanedTurn(revived, found[0]!.orphan);
    expect(revived.state.activeMessage).toBeUndefined();

    const interrupted: unknown[] = [];
    for await (const e of store.read(sessionId)) if (e.type === 'message.interrupted') interrupted.push(e.payload);
    expect(interrupted).toEqual([{ messageId, reason: 'crash' }]);
  });

  it("kind: none —— 崩在迭代边界上，什么都不用补，直接 turn.end(aborted)", async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: 'hi' }] } });

    const found = await scanForOrphanedSessions(store);
    expect(found[0]!.orphan).toEqual({ turnId, kind: 'none' });

    const revived = dead;
    const reason = await abandonOrphanedTurn(revived, found[0]!.orphan);
    expect(reason).toBe('aborted');
    expect(revived.state.status).toBe('idle');
  });

  it('子 Agent 会话不参与孤儿扫描：收尾由父会话那侧负责', async () => {
    const store = new MemoryEventStore();
    const parentSessionId = newSessionId();
    const childSessionId = newSessionId();

    /*
     * 一条停在半途的子会话。它看起来完全符合"孤儿"的形状，但收尾归
     * `recoverInterruptedSubagents()` 从父会话那侧补 `subagent.end`（ADR-0049 §4）。
     * 这里再报一次，用户就会看到"某某会话中断了、要恢复吗"——而那根本不是他的对话。
     */
    const child = await SessionRuntime.open({ sessionId: childSessionId, store, bus: new EventBus() });
    await child.record({
      type: 'session.created',
      payload: { cwd: '/repo', modelRef: 'scripted/scripted-1', parentSessionId, parentCallId: newCallId() },
    });
    const childTurnId = newTurnId();
    await child.record({
      type: 'turn.start',
      turnId: childTurnId,
      payload: { turnId: childTurnId, input: [{ type: 'text', text: '只读探索' }] },
    });
    await child.close();

    expect(await scanForOrphanedSessions(store)).toEqual([]);
  });

  it('干净结束的会话不是孤儿：scanForOrphanedSessions 不误报', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await runtime.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    await runtime.close();

    expect(await scanForOrphanedSessions(store)).toEqual([]);
  });

  it('继续：合成收尾事件之后重新进入 driveTurnLoop，正常收敛（不重放原始工具调用）', async () => {
    const store = new MemoryEventStore();
    const sessionId = newSessionId();
    const dead = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
    await dead.record({ type: 'session.created', payload: { cwd: '/repo', modelRef: 'scripted/scripted-1' } });
    const turnId = newTurnId();
    await dead.record({ type: 'turn.start', turnId, payload: { turnId, input: [{ type: 'text', text: '列个目录' }] } });
    const callId = newCallId();
    const assistantMessageId = newMessageId();
    await dead.record({
      type: 'message.end',
      turnId,
      payload: {
        message: {
          id: assistantMessageId,
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: callId, name: 'fs.list', input: { path: '/repo' } }],
          ts: Date.now(),
        },
      },
    });
    await dead.record({
      type: 'tool.start',
      turnId,
      payload: { callId, messageId: assistantMessageId, name: 'fs.list', input: { path: '/repo' }, risk: 'safe', capabilities: ['fs.read'] },
    });

    const found = await scanForOrphanedSessions(store);
    const orphan = found[0]!.orphan;

    const revived = dead;
    await synthesizeInterruption(revived, orphan);
    // 续跑：脚本里模型看到中断结果之后直接结束这一轮
    const reason = await resumeTurn(
      {
        runtime: revived,
        provider: new ScriptedProvider({ turns: [{ chunks: [{ kind: 'stop', reason: 'end_turn' }] }] }),
        tools: new ToolRegistry(),
        layers: builtinLayers(ENV),
        model: 'x',
      },
      orphan.turnId,
    );

    expect(reason).toBe('end_turn');
    expect(revived.state.status).toBe('idle');
    expect(revived.state.activeTurn).toBeUndefined();
    expect(revived.state.runningCalls.size).toBe(0);
  });
});
