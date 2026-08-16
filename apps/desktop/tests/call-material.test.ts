import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newCallId, newMessageId, xmError } from '@xm/contracts';
import type { Message } from '@xm/contracts';
import { toDispatchView } from '../src/shared/code-dispatch.js';
import {
  DISPATCH_OUTPUT_NOTICE,
  childDispatches,
  countNativeToolCalls,
  detailsScrollHost,
  formatDispatchOutput,
  formatInputJson,
  lookupCallMaterial,
  nextDetailsTab,
  shouldOpenDetailsOnSelect,
  shouldShowDetailsColumn,
} from '../src/renderer/lib/call-material.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer');

function nativeMessages(
  callId: ReturnType<typeof newCallId>,
  input: unknown,
  resultText: string,
): Message[] {
  return [
    {
      id: newMessageId(),
      role: 'assistant',
      ts: 1,
      blocks: [{ type: 'tool_use', id: callId, name: 'demo.echo', input }],
    },
    {
      id: newMessageId(),
      role: 'user',
      ts: 2,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: callId,
          content: [{ type: 'text', text: resultText }],
          isError: false,
        },
      ],
    },
  ];
}

describe('lookupCallMaterial：由 callId 从已有材料反查', () => {
  it('模型发起的调用：入参与结果都来自 messages', () => {
    const callId = newCallId();
    const material = lookupCallMaterial(
      nativeMessages(callId, { path: 'a.ts' }, 'hello'),
      new Map(),
      callId,
    );
    expect(material).toEqual({
      kind: 'native',
      callId,
      name: 'demo.echo',
      input: { path: 'a.ts' },
      output: { text: 'hello', isError: false },
    });
  });

  it('还在跑的调用：有入参、没有结果', () => {
    const callId = newCallId();
    const messages: Message[] = [
      {
        id: newMessageId(),
        role: 'assistant',
        ts: 1,
        blocks: [{ type: 'tool_use', id: callId, name: 'demo.echo', input: { n: 1 } }],
      },
    ];
    const material = lookupCallMaterial(messages, new Map(), callId);
    expect(material?.kind).toBe('native');
    if (material?.kind !== 'native') return;
    expect(material.output).toBeUndefined();
  });

  it('子调用：入参来自 dispatch 投影，Output 形状里没有结果正文', () => {
    const parent = newCallId();
    const child = newCallId();
    const view = toDispatchView({
      callId: child,
      parentCallId: parent,
      index: 0,
      name: 'demo.echo',
      input: { path: 'b.ts' },
      ok: true,
      durationMs: 3,
    });
    const material = lookupCallMaterial([], new Map([[child, view]]), child);
    expect(material?.kind).toBe('dispatch');
    if (material?.kind !== 'dispatch') return;
    expect(material.input).toEqual({ path: 'b.ts' });
    expect(material.ok).toBe(true);
    expect(material).not.toHaveProperty('forModel');
    expect(material).not.toHaveProperty('output');
  });
});

describe('Code Mode 子调用的 Output 拿不到结果正文', () => {
  it('🔴 给 dispatch 硬编 forModel → 投影剥掉，详情文案也不含那份正文', () => {
    const parent = newCallId();
    const child = newCallId();
    const view = toDispatchView({
      callId: child,
      parentCallId: parent,
      index: 0,
      name: 'demo.echo',
      input: { q: 1 },
      ok: true,
      durationMs: 4,
      forModel: [{ type: 'text', text: 'SECRET_BODY' }],
    });
    expect(view).not.toHaveProperty('forModel');
    expect(JSON.stringify(view)).not.toContain('SECRET_BODY');

    const material = lookupCallMaterial([], new Map([[child, view]]), child);
    expect(material?.kind).toBe('dispatch');
    if (material?.kind !== 'dispatch') return;
    const formatted = formatDispatchOutput(material);
    expect(formatted.body).toBe('已执行');
    expect(formatted.notice).toBe(DISPATCH_OUTPUT_NOTICE);
    expect(formatted.body).not.toContain('SECRET_BODY');
    expect(formatted.notice).not.toContain('SECRET_BODY');
    expect(formatted.notice).toContain('不是数据缺失');
  });

  it('失败时 Output 只给失败原因，仍然没有正文', () => {
    const parent = newCallId();
    const child = newCallId();
    const view = toDispatchView({
      callId: child,
      parentCallId: parent,
      index: 1,
      name: 'demo.echo',
      input: {},
      ok: false,
      durationMs: 1,
      error: xmError('policy_denied', '红线拒绝'),
    });
    const material = lookupCallMaterial([], new Map([[child, view]]), child);
    expect(material?.kind).toBe('dispatch');
    if (material?.kind !== 'dispatch') return;
    expect(formatDispatchOutput(material).body).toBe('红线拒绝');
  });
});

describe('子调用按 parentCallId 挂到展开后的父行下', () => {
  it('只收集该父调用的子调用，并按 index 排序', () => {
    const parent = newCallId();
    const other = newCallId();
    const first = toDispatchView({
      callId: newCallId(),
      parentCallId: parent,
      index: 1,
      name: 'b',
      input: {},
      ok: true,
      durationMs: 1,
    });
    const zeroth = toDispatchView({
      callId: newCallId(),
      parentCallId: parent,
      index: 0,
      name: 'a',
      input: {},
      ok: true,
      durationMs: 1,
    });
    const stray = toDispatchView({
      callId: newCallId(),
      parentCallId: other,
      index: 0,
      name: 'x',
      input: {},
      ok: true,
      durationMs: 1,
    });
    const kids = childDispatches(
      new Map([
        [first.callId, first],
        [zeroth.callId, zeroth],
        [stray.callId, stray],
      ]),
      parent,
    );
    expect(kids.map((item) => item.name)).toEqual(['a', 'b']);
  });
});

describe('右栏 tab 与开关', () => {
  it('无选中落在工作区；新选中切到详情；同一选中保留用户点过的 tab', () => {
    const callId = newCallId();
    expect(nextDetailsTab(callId, undefined, 'details')).toBe('workspace');
    expect(nextDetailsTab(undefined, callId, 'workspace')).toBe('details');
    expect(nextDetailsTab(callId, callId, 'workspace')).toBe('workspace');
  });

  it('点一行且右栏关着 → 打开；已经开着或点的是同一行 → 不动开关', () => {
    const a = newCallId();
    const b = newCallId();
    expect(shouldOpenDetailsOnSelect(undefined, a, false)).toBe(true);
    expect(shouldOpenDetailsOnSelect(undefined, a, true)).toBe(false);
    expect(shouldOpenDetailsOnSelect(a, a, false)).toBe(false);
    expect(shouldOpenDetailsOnSelect(a, b, false)).toBe(true);
  });

  it('有工具调用或选中时也出右栏开关，不只靠工作区四块', () => {
    expect(
      shouldShowDetailsColumn({
        hasWorkspaceBlocks: false,
        selected: false,
        nativeCalls: 0,
        dispatchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowDetailsColumn({
        hasWorkspaceBlocks: false,
        selected: false,
        nativeCalls: 1,
        dispatchCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowDetailsColumn({
        hasWorkspaceBlocks: false,
        selected: true,
        nativeCalls: 0,
        dispatchCount: 0,
      }),
    ).toBe(true);
  });
});

describe('关闭右栏必须保持挂载', () => {
  it('🔴 关闭改成 unmount → 滚动宿主身份分裂', () => {
    expect(detailsScrollHost(true)).toBe('mounted');
    expect(detailsScrollHost(true)).toBe(detailsScrollHost(false));
  });

  it('右栏源码：内层不按 collapsed / tab 卸载', () => {
    const src = readFileSync(join(SRC, 'components/workbench-panel.tsx'), 'utf8');
    expect(src).toContain('workspace-panel__inner');
    expect(src).toContain('data-details-scroll');
    expect(src).toContain("hidden={tab !== 'details'}");
    expect(src).toContain("hidden={tab !== 'workspace'}");
    expect(src).not.toMatch(/collapsed\s*&&\s*\(?\s*<div[^>]*workspace-panel__inner/);
    expect(src).not.toMatch(/tab === 'details'\s*&&/);
    expect(src).not.toMatch(/tab === 'workspace'\s*&&/);
    expect(countNativeToolCalls([])).toBe(0);
  });
});

describe('入参 JSON', () => {
  it('对象格式化；循环引用不抛', () => {
    expect(formatInputJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(formatInputJson(cyclic)).toContain('[object Object]');
  });
});
