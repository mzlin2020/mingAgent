import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersistedEvent, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { ExtEventDeclaration } from '@xm/kernel';
import { ExtEventRejected, emptySessionState, reduce, summarizeExtRecords } from '@xm/kernel';
import { openStores } from '@xm/storage';
import { EventBus, SessionRuntime, createExtRecorder } from '../src/index.js';

/**
 * 插件事件走真实存储的一整趟（ADR-0057）。
 *
 * 用真库而不是内存实现，是因为这一段要证明的三件事全都在**跨进程边界**上：
 * 事件真的落了盘、重开会话时真的读得回来、而核心状态真的没因为它变过一位。
 * 内存实现里"落盘"是一次数组 push，那三件事一件也没被检验到。
 */

const ROOT = mkdtempSync(join(tmpdir(), 'xm-ext-events-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const paths = {
  home: ROOT,
  sourceRoot: join(ROOT, 'app'),
  data: join(ROOT, 'data'),
  config: join(ROOT, 'config'),
  cache: join(ROOT, 'cache'),
  logs: join(ROOT, 'logs'),
};

const declaration: ExtEventDeclaration = {
  manifest: {
    id: 'ghost',
    events: { 'commit.created': 'persisted', 'index.progress': 'transient' },
  },
  schemas: {
    'commit.created': z.strictObject({ sha: z.string() }),
    'index.progress': z.strictObject({ done: z.number().int() }),
  },
};

const openSession = async (
  sessionId: SessionId,
): Promise<{
  runtime: SessionRuntime;
  bus: EventBus;
  close: () => Promise<void>;
}> => {
  const stores = await openStores(paths);
  const bus = new EventBus();
  const runtime = await SessionRuntime.open({ sessionId, store: stores.events, bus });
  return {
    runtime,
    bus,
    close: async () => {
      await runtime.close();
      await stores.close();
    },
  };
};

describe('插件事件的一整趟：写入 → 落库 → 重开会话', () => {
  it('持久插件事件落库、占 seq，但核心状态一位不动；重开后仍在', async () => {
    const sessionId = newSessionId();
    const first = await openSession(sessionId);
    await first.runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'anthropic/claude-opus-5' },
    });
    const before = first.runtime.state;

    const recorder = createExtRecorder({ runtime: first.runtime, declaration });
    const event = await recorder.record({
      name: 'commit.created',
      durability: 'persisted',
      data: { sha: 'deadbeef' },
    });
    expect(event.type).toBe('ext.persisted');
    expect(event.payload.pluginId).toBe('ghost');
    expect(event.seq).toBe(before.lastSeq + 1);

    const after = first.runtime.state;
    expect(after.lastSeq).toBe(before.lastSeq + 1);
    expect({ ...after, lastSeq: 0 }).toEqual({ ...before, lastSeq: 0 });
    await first.close();

    // 重开：插件没装（也永远装不上，它是个不存在的插件），事件必须还在
    const second = await openSession(sessionId);
    const rows: PersistedEvent[] = [];
    for await (const e of second.runtime.read({ types: ['ext.persisted'] })) rows.push(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      pluginId: 'ghost',
      name: 'commit.created',
      version: 1,
      data: { sha: 'deadbeef' },
    });

    // reduce 恒等：把插件事件从流里拿掉，重放出的状态与实际状态只差 lastSeq
    const all: PersistedEvent[] = [];
    for await (const e of second.runtime.read()) all.push(e);
    const withoutExt = all
      .filter((e) => e.type !== 'ext.persisted')
      .reduce(reduce, emptySessionState(sessionId));
    expect({ ...second.runtime.state, lastSeq: 0 }).toEqual({ ...withoutExt, lastSeq: 0 });

    // UI 的说明由这份汇总喂：插件没装着，如实标出来，不清理也不报错
    expect(summarizeExtRecords(all, new Set())).toEqual([
      {
        pluginId: 'ghost',
        count: 1,
        firstSeq: rows[0]?.seq,
        lastSeq: rows[0]?.seq,
        names: ['commit.created'],
        installed: false,
      },
    ]);
    await second.close();
  });

  it('瞬态插件事件上总线但不落库、不占 seq', async () => {
    const sessionId = newSessionId();
    const session = await openSession(sessionId);
    await session.runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'anthropic/claude-opus-5' },
    });
    const seen: string[] = [];
    session.bus.subscribe((e) => seen.push(e.type));

    const recorder = createExtRecorder({ runtime: session.runtime, declaration });
    const before = session.runtime.lastSeq;
    await recorder.record({ name: 'index.progress', durability: 'transient', data: { done: 3 } });
    expect(seen).toEqual(['ext.transient']);
    expect(session.runtime.lastSeq).toBe(before);

    // `read()` 的返回类型是 `PersistedEvent`——"瞬态事件不在库里"这件事在这里
    // 是类型层面的事实，用例只需要证明它确实什么也没多写
    const persisted: PersistedEvent[] = [];
    for await (const e of session.runtime.read()) persisted.push(e);
    expect(persisted.map((e) => e.type)).toEqual(['session.created']);
    await session.close();
  });

  it('清单里没声明的事件：在写入之前就被拒，事件流上一条都不多', async () => {
    const sessionId = newSessionId();
    const session = await openSession(sessionId);
    await session.runtime.record({
      type: 'session.created',
      payload: { cwd: '/w', modelRef: 'anthropic/claude-opus-5' },
    });
    const before = session.runtime.lastSeq;

    const recorder = createExtRecorder({ runtime: session.runtime, declaration });
    await expect(
      recorder.record({ name: 'commit.pushed', durability: 'persisted', data: {} }),
    ).rejects.toBeInstanceOf(ExtEventRejected);
    expect(session.runtime.lastSeq).toBe(before);

    const persisted: PersistedEvent[] = [];
    for await (const e of session.runtime.read()) persisted.push(e);
    expect(persisted.map((e) => e.type)).toEqual(['session.created']);
    await session.close();
  });
});
