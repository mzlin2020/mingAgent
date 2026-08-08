import { describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import { CH } from '../src/shared/channels.js';
import {
  CreateSessionRequest,
  GetApprovalModeRequest,
  GetApprovalModeResult,
  IpcEnvelope,
  ListSessionsResult,
  MAX_IMAGES_PER_MESSAGE,
  PushedEvent,
  ReadBlobRequest,
  ReadBlobResult,
  ReadSessionRequest,
  SendUserMessageRequest,
  SetApprovalModeRequest,
  SetApprovalModeResult,
} from '../src/shared/ipc.js';

/**
 * IPC 契约的可执行部分（ADR-0015）。
 *
 * 这里跑不了 Electron（需要 GUI），但**契约本身是纯数据**，与 Electron 无关——
 * 而 ADR-0015 的几条主张恰恰全都落在契约上：主进程不信任渲染层、
 * 渲染层用 loose 信封容忍未知事件、失败是返回值而不是异常。
 * 这些不该只靠"启动一次看看"来验。
 */

describe('主进程不信任渲染层送上来的东西', () => {
  it('🔴 幻觉字段被拒绝 —— strictObject 不是装饰', () => {
    expect(CreateSessionRequest.safeParse({ title: 'x', isAdmin: true }).success).toBe(false);
    expect(
      SendUserMessageRequest.safeParse({
        sessionId: newSessionId(),
        text: 'hi',
        skipPermissionChecks: true,
      }).success,
    ).toBe(false);
  });

  it('🔴 sessionId 必须是合法 ID，不是任意字符串', () => {
    expect(SendUserMessageRequest.safeParse({ sessionId: '../../etc/passwd', text: 'x' }).success)
      .toBe(false);
    expect(ReadSessionRequest.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
  });

  it('🔴 文本长度有上限 —— 无界字符串进来就是一次无界落库', () => {
    const sessionId = newSessionId();
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '' }).success).toBe(false);
    expect(
      SendUserMessageRequest.safeParse({ sessionId, text: 'x'.repeat(100_001) }).success,
    ).toBe(false);
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'x'.repeat(100_000) }).success)
      .toBe(true);
  });

  it('fromSeq 必须是正整数（seq 从 1 起，无空洞）', () => {
    const sessionId = newSessionId();
    expect(ReadSessionRequest.safeParse({ sessionId, fromSeq: 0 }).success).toBe(false);
    expect(ReadSessionRequest.safeParse({ sessionId, fromSeq: 1.5 }).success).toBe(false);
    expect(ReadSessionRequest.safeParse({ sessionId, fromSeq: 1 }).success).toBe(true);
  });
});

describe('多模态：图片附件', () => {
  const img = (data = 'aGVsbG8=') => ({ data, mime: 'image/png' });

  it('文字和图片是或的关系 —— 只发图片、不带文字应该通过', () => {
    const sessionId = newSessionId();
    expect(
      SendUserMessageRequest.safeParse({ sessionId, text: '', images: [img()] }).success,
    ).toBe(true);
  });

  it('🔴 文字和图片都是空 —— 两道闸门都不满足，拒绝', () => {
    const sessionId = newSessionId();
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '' }).success).toBe(false);
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '', images: [] }).success).toBe(
      false,
    );
  });

  it(`🔴 超过 ${String(MAX_IMAGES_PER_MESSAGE)} 张图被拒绝`, () => {
    const sessionId = newSessionId();
    const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => img());
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'hi', images }).success).toBe(
      false,
    );
    expect(
      SendUserMessageRequest.safeParse({
        sessionId,
        text: 'hi',
        images: images.slice(0, MAX_IMAGES_PER_MESSAGE),
      }).success,
    ).toBe(true);
  });

  it('🔴 单图 base64 超过上限被拒绝 —— 精确字节数在 main 侧解码后再查一次', () => {
    const sessionId = newSessionId();
    const huge = img('a'.repeat(14 * 1024 * 1024 + 1));
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'hi', images: [huge] }).success)
      .toBe(false);
  });

  it('ReadBlobRequest 需要一个完整的 BlobRef，不是裸 hash', () => {
    expect(ReadBlobRequest.safeParse({ ref: { hash: 'a'.repeat(64) } }).success).toBe(false);
    expect(
      ReadBlobRequest.safeParse({ ref: { hash: 'a'.repeat(64), mime: 'image/png', size: 3 } })
        .success,
    ).toBe(true);
  });

  it('ReadBlobResult 就是一个 data URL 字符串', () => {
    expect(ReadBlobResult.safeParse({ dataUrl: 'data:image/png;base64,aGVsbG8=' }).success).toBe(
      true,
    );
  });
});

describe('审批模式（docs/09 C6）', () => {
  it('三档模式都能通过，别的字符串一律拒绝', () => {
    const sessionId = newSessionId();
    for (const mode of ['ask', 'auto', 'full']) {
      expect(SetApprovalModeRequest.safeParse({ sessionId, mode }).success).toBe(true);
    }
    expect(SetApprovalModeRequest.safeParse({ sessionId, mode: 'yolo' }).success).toBe(false);
  });

  it('🔴 幻觉字段被拒绝', () => {
    const sessionId = newSessionId();
    expect(
      SetApprovalModeRequest.safeParse({ sessionId, mode: 'ask', tier: 'strict' }).success,
    ).toBe(false);
  });

  it('GetApprovalModeRequest 只要 sessionId', () => {
    expect(GetApprovalModeRequest.safeParse({ sessionId: newSessionId() }).success).toBe(true);
    expect(GetApprovalModeRequest.safeParse({}).success).toBe(false);
  });

  it('Result 都是 { mode }', () => {
    expect(GetApprovalModeResult.safeParse({ mode: 'auto' }).success).toBe(true);
    expect(SetApprovalModeResult.safeParse({ mode: 'full' }).success).toBe(true);
  });
});

describe('失败是返回值，不是异常', () => {
  it('信封能表达失败，且带得住 code', () => {
    const parsed = IpcEnvelope.safeParse({
      ok: false,
      code: 'policy_denied',
      message: '红线拒绝',
    });
    expect(parsed.success).toBe(true);
    // UI 要靠 code 说出"改策略 / 重新审批 / 改系统权限"这三句不同的话
    expect(parsed.success && !parsed.data.ok && parsed.data.code).toBe('policy_denied');
  });

  it('成功信封的 data 不预设形状 —— 载荷单独解一次', () => {
    expect(IpcEnvelope.safeParse({ ok: true, data: { anything: 1 } }).success).toBe(true);
  });

  it('不是信封的东西一律拒绝', () => {
    expect(IpcEnvelope.safeParse({ oops: 1 }).success).toBe(false);
    expect(IpcEnvelope.safeParse(null).success).toBe(false);
  });
});

describe('渲染层对未知事件的容忍', () => {
  /**
   * 用 loose 的 `EventEnvelope` 而不是判别联合：渲染层拿到未知类型的事件应该原样
   * 忽略并继续，不该整条流断掉——那是版本漂移的正常形态，不是错误。
   */
  it('未来版本的事件类型仍能通过信封解析', () => {
    const parsed = PushedEvent.safeParse({
      id: newSessionId(),
      sessionId: newSessionId(),
      seq: 7,
      ts: 1,
      type: 'something.fromTheFuture',
      v: 3,
      payload: { whatever: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('信封本身的必填字段还是必填的', () => {
    expect(PushedEvent.safeParse({ type: 'x', payload: {} }).success).toBe(false);
  });
});

describe('会话列表投影的形状', () => {
  it('lastSeq = 0 是合法的（会话已建但一条事件都没有）', () => {
    const r = ListSessionsResult.safeParse([
      { sessionId: newSessionId(), createdAt: 0, updatedAt: 0, lastSeq: 0 },
    ]);
    expect(r.success).toBe(true);
  });
});

describe('通道名', () => {
  it('全部带 xm: 前缀，不与别的 IPC 撞名', () => {
    for (const name of Object.values(CH)) expect(name.startsWith('xm:')).toBe(true);
    expect(new Set(Object.values(CH)).size).toBe(Object.values(CH).length);
  });
});
