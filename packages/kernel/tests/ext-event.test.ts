import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEvent, newSessionId } from '@xm/contracts';
import type { ExtEventDeclaration } from '@xm/kernel';
import {
  ExtEventRejected,
  emptySessionState,
  prepareExtEvent,
  reduce,
  summarizeExtRecords,
} from '@xm/kernel';

const declaration: ExtEventDeclaration = {
  manifest: {
    id: 'git',
    events: { 'commit.created': 'persisted', 'index.progress': 'transient' },
  },
  schemas: {
    'commit.created': z.strictObject({ sha: z.string(), files: z.number().int() }),
    'index.progress': z.strictObject({ done: z.number().int() }),
  },
};

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExtEventRejected) return error.reason;
    return `非 ExtEventRejected：${String(error)}`;
  }
  return '没有抛出';
};

describe('插件事件的写入闸门（ADR-0057）', () => {
  it('声明过的事件按清单的层级进对应信封', () => {
    const persisted = prepareExtEvent(declaration, {
      name: 'commit.created',
      durability: 'persisted',
      data: { sha: 'abc', files: 3 },
    });
    expect(persisted.type).toBe('ext.persisted');
    expect(persisted.payload).toEqual({
      pluginId: 'git',
      name: 'commit.created',
      version: 1,
      data: { sha: 'abc', files: 3 },
    });

    const transient = prepareExtEvent(declaration, {
      name: 'index.progress',
      durability: 'transient',
      data: { done: 7 },
    });
    expect(transient.type).toBe('ext.transient');
  });

  it('清单里没声明的事件当场拒绝，不静默丢弃也不猜层级', () => {
    expect(
      reasonOf(() =>
        prepareExtEvent(declaration, {
          name: 'commit.pushed',
          durability: 'persisted',
          data: {},
        }),
      ),
    ).toBe('undeclared');
  });

  it('声明 persisted 却写进 transient 信封 → 拒绝', () => {
    expect(
      reasonOf(() =>
        prepareExtEvent(declaration, {
          name: 'commit.created',
          durability: 'transient',
          data: { sha: 'abc', files: 3 },
        }),
      ),
    ).toBe('durability-mismatch');
  });

  it('没注册载荷 schema → 拒绝（不因为写入者是插件就放松契约单一来源）', () => {
    const noSchema: ExtEventDeclaration = {
      manifest: { id: 'git', events: { 'commit.created': 'persisted' } },
      schemas: {},
    };
    expect(
      reasonOf(() =>
        prepareExtEvent(noSchema, { name: 'commit.created', durability: 'persisted', data: {} }),
      ),
    ).toBe('no-schema');
  });

  it('data 不过 schema → 拒绝并记录，不静默兜底', () => {
    expect(
      reasonOf(() =>
        prepareExtEvent(declaration, {
          name: 'commit.created',
          durability: 'persisted',
          data: { sha: 'abc', files: '3' },
        }),
      ),
    ).toBe('invalid-data');
  });

  /**
   * ADR-0057 反向演练 2 与 3 是**结构性**的：`ExtEventDraft` 上既没有 `pluginId`
   * 也没有 `type`。这条用例用一个带多余字段的 draft 把它钉住——多传的 `pluginId`
   * 不是"被覆盖"，是根本没人读它。
   */
  it('插件伪造 pluginId / 事件类型：在接口上就做不到', () => {
    const forged = { name: 'commit.created', durability: 'persisted', data: { sha: 'a', files: 1 } };
    const prepared = prepareExtEvent(declaration, {
      ...forged,
      pluginId: 'mcp',
      type: 'tool.end',
    } as never);
    expect(prepared.payload.pluginId).toBe('git');
    expect(prepared.type).toBe('ext.persisted');
  });

  it('事件名不合法（大写、前导符号、空名、超长）一律拒绝', () => {
    for (const name of ['Commit', '-commit', '', 'a'.repeat(65)]) {
      expect(
        reasonOf(() =>
          prepareExtEvent(declaration, { name, durability: 'persisted', data: {} }),
        ),
        name,
      ).toBe('invalid-name');
    }
  });
});

describe('reduce 对插件事件恒等（ADR-0057 §三）', () => {
  const sessionId = newSessionId();
  const base = reduce(
    emptySessionState(sessionId),
    createEvent({
      type: 'session.created',
      sessionId,
      seq: 1,
      ts: 1,
      payload: { cwd: '/w', modelRef: 'anthropic/claude-opus-5' },
    }),
  );

  it('持久插件事件只推进 lastSeq，其余状态逐字节不变', () => {
    const after = reduce(
      base,
      createEvent({
        type: 'ext.persisted',
        sessionId,
        seq: 2,
        ts: 2,
        payload: { pluginId: 'ghost', name: 'anything', version: 9, data: { a: 1 } },
      }),
    );
    expect(after.lastSeq).toBe(2);
    expect({ ...after, lastSeq: 0 }).toEqual({ ...base, lastSeq: 0 });
  });

  it('瞬态插件事件连 lastSeq 都不动', () => {
    const after = reduce(
      base,
      createEvent({
        type: 'ext.transient',
        sessionId,
        seq: 1,
        ts: 2,
        payload: { pluginId: 'ghost', name: 'anything', version: 1, data: {} },
      }),
    );
    expect(after).toEqual(base);
  });
});

describe('未安装插件的记录：不丢，且有说明', () => {
  const sessionId = newSessionId();
  const ext = (seq: number, pluginId: string, name: string) =>
    createEvent({
      type: 'ext.persisted' as const,
      sessionId,
      seq,
      ts: seq,
      payload: { pluginId, name, version: 1, data: {} },
    });

  it('按 pluginId 汇总，装没装着都如实标出', () => {
    const summaries = summarizeExtRecords(
      [ext(2, 'ghost', 'b'), ext(3, 'git', 'commit.created'), ext(4, 'ghost', 'a')],
      new Set(['git']),
    );
    expect(summaries).toEqual([
      { pluginId: 'ghost', count: 2, firstSeq: 2, lastSeq: 4, names: ['a', 'b'], installed: false },
      {
        pluginId: 'git',
        count: 1,
        firstSeq: 3,
        lastSeq: 3,
        names: ['commit.created'],
        installed: true,
      },
    ]);
  });
});
