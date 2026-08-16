import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newCallId, newEventId, newMessageId, newSessionId, newTurnId } from '@xm/contracts';
import type { PersistedEvent, SessionId } from '@xm/contracts';
import type { SealedEvent } from '@xm/kernel';
import { sealEvent } from '@xm/kernel';
import { openStores } from '@xm/storage';
import { createInvariantRegistry, scanAllSessions } from '../src/index.js';

/**
 * 离线不变量扫描器（ADR-0060 的遗留项，CLI 在 `scripts/scan-invariants.mjs`）。
 *
 * 写入路径上的闸门只管**将来**写进去的事件；历史库里已经存在的违例查不出来，
 * 这个扫描器补的就是那一格。它是诊断而不是闸门（老会话带着历史缺陷，
 * 开机即报会让人当场关掉它），所以**必须有一条用例替它跑**——
 * 否则它就是下一个"写完再没跑过"的脚本，而那正是本仓库栽过八次的形状。
 *
 * 用真库不用内存实现：脏库这件事本身就是"盘上躺着的东西"，
 * 而且要顺带证明 SQLite 那条读路径与扫描器接得上。
 */

const ROOT = mkdtempSync(join(tmpdir(), 'xm-scan-invariants-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const pathsIn = (dir: string): Parameters<typeof openStores>[0] => ({
  home: dir,
  appRoot: join(dir, 'app'),
  data: join(dir, 'data'),
  config: join(dir, 'config'),
  cache: join(dir, 'cache'),
  logs: join(dir, 'logs'),
});

/**
 * 往一个真库里写一串事件。
 *
 * 注意**只能造 SQLite 允许的脏**：`append` 自己校验 seq 连续（`SeqConflictError`），
 * 所以"seq 空洞"这类违例在这条路上根本造不出来——那也正说明扫描器的价值域在别处：
 * **载荷层面的失配**（谁跟谁配对、谁在谁之前），存储层不管，只有不变量管。
 */
const writeSession = async (
  dir: string,
  build: (
    stamp: (event: Omit<PersistedEvent, 'id' | 'seq' | 'ts' | 'v' | 'sessionId'>) => SealedEvent,
  ) => readonly SealedEvent[],
): Promise<{ sessionId: SessionId; dir: string }> => {
  const stores = await openStores(pathsIn(dir));
  const sessionId = newSessionId();
  let seq = 0;
  const stamp = (event: Omit<PersistedEvent, 'id' | 'seq' | 'ts' | 'v' | 'sessionId'>) =>
    sealEvent({
      ...event,
      id: newEventId(),
      seq: ++seq,
      ts: 1_700_000_000_000 + seq,
      v: 1,
      sessionId,
    } as unknown as PersistedEvent);

  const writer = await stores.events.openForWrite(sessionId);
  await writer.append(build(stamp));
  await writer.close();
  await stores.close();
  return { sessionId, dir };
};

const scan = async (dir: string): Promise<ReturnType<typeof scanAllSessions>> => {
  const stores = await openStores(pathsIn(dir));
  const { registry, dispose } = createInvariantRegistry();
  try {
    return await scanAllSessions({ events: stores.events, registry });
  } finally {
    dispose();
    await stores.close();
  }
};

describe('离线不变量扫描器', () => {
  it('干净的库扫出零违例', async () => {
    const dir = join(ROOT, 'clean');
    const turnId = newTurnId();
    const callId = newCallId();
    await writeSession(dir, (stamp) => [
      stamp({ type: 'session.created', payload: { cwd: '/w', modelRef: 'anthropic/x' } }),
      stamp({ type: 'turn.start', turnId, payload: { turnId, input: [] } }),
      stamp({
        type: 'tool.start',
        turnId,
        payload: {
          callId,
          messageId: newMessageId(),
          name: 'fs.read',
          input: { path: '/w/a.ts' },
          risk: 'safe',
          capabilities: ['fs.read'],
        },
      }),
      stamp({
        type: 'tool.end',
        turnId,
        payload: { callId, ok: true, durationMs: 1, forModel: [{ type: 'text', text: 'ok' }] },
      }),
      stamp({ type: 'turn.end', turnId, payload: { turnId, reason: 'end_turn' } }),
    ]);

    const results = await scan(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.violations).toEqual([]);
    expect(results[0]?.events).toBe(5);
  });

  it('🔴 脏库里的两处违例都被捞出来，且带着 seq 与不变量名', async () => {
    const dir = join(ROOT, 'dirty');
    const first = newTurnId();
    const second = newTurnId();
    const orphan = newCallId();
    await writeSession(dir, (stamp) => [
      stamp({ type: 'session.created', payload: { cwd: '/w', modelRef: 'anthropic/x' } }),
      stamp({ type: 'turn.start', turnId: first, payload: { turnId: first, input: [] } }),
      // ① 上一个回合还没收尾，第二个就开了
      stamp({ type: 'turn.start', turnId: second, payload: { turnId: second, input: [] } }),
      // ② 一条成功的 tool.end，却没有配对的 tool.start
      stamp({
        type: 'tool.end',
        turnId: second,
        payload: { callId: orphan, ok: true, durationMs: 1, forModel: [] },
      }),
      stamp({ type: 'turn.end', turnId: second, payload: { turnId: second, reason: 'end_turn' } }),
    ]);

    const results = await scan(dir);
    const violations = results.flatMap((result) => result.violations);
    expect(violations.map((v) => ({ seq: v.seq, invariant: v.invariant, pkg: v.package }))).toEqual([
      { seq: 3, invariant: '同一时刻只有一个打开的回合', pkg: '@xm/runtime' },
      { seq: 4, invariant: '成功的 tool.end 必有配对的 tool.start', pkg: '@xm/kernel' },
    ]);
    // 违例消息要能直接读懂发生了什么，而不是只给一个编号
    expect(violations[0]?.message).toContain(first);
    expect(violations[1]?.message).toContain(orphan);
  });

  /**
   * 扫描器**不抛**，把违例一次列全。
   *
   * 写入路径抛 `InvariantError` 是对的（那一条正在发生，要拦住）；离线扫一个历史库
   * 停在第一条则毫无用处——你要的恰恰是这个库到底烂了几处。
   */
  it('遇到违例不中断，后面的会话照扫', async () => {
    const dir = join(ROOT, 'many');
    const build = (bad: boolean) =>
      writeSession(dir, (stamp) => {
        const turnId = newTurnId();
        const other = newTurnId();
        return [
          stamp({ type: 'session.created', payload: { cwd: '/w', modelRef: 'anthropic/x' } }),
          stamp({ type: 'turn.start', turnId, payload: { turnId, input: [] } }),
          ...(bad
            ? [stamp({ type: 'turn.start', turnId: other, payload: { turnId: other, input: [] } })]
            : []),
        ];
      });
    await build(true);
    await build(false);
    await build(true);

    const results = await scan(dir);
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.violations.length > 0)).toHaveLength(2);
    expect(results.flatMap((r) => r.violations)).toHaveLength(2);
  });
});
